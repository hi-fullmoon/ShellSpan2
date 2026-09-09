import { createHash, randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { resolveModel, type ProviderConfig } from './llm-catalog.ts';
import { redactDiagnostic } from './redaction.ts';

type VisionContract = {
  version: number;
  sourceMimeTypes: string[];
  maxSourceBytes: number;
  maxBatchBytes: number;
  maxImages: number;
  maxSourcePixels: number;
  maxSourceDimension: number;
  maxDecodeBytes: number;
  maxFrames: number;
  normalizedMimeType: 'image/png';
  maxNormalizedPixels: number;
  maxNormalizedDimension: number;
  maxNormalizedBytes: number;
};
const vision = JSON.parse(
  readFileSync(join(__dirname, 'vision-contract.json'), 'utf8'),
) as VisionContract;
if (vision.version !== 1 || vision.maxFrames !== 1) throw new Error('Invalid vision contract');

export type ImageUpload = { mediaType: string; data: string; name: string };
export type ImageReference = {
  version: 1;
  sha256: string;
  mediaType: 'image/png';
  bytes: number;
  width: number;
  height: number;
  name: string;
};
type PreparedImage = { reference: ImageReference; bytes: Buffer };

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('IMAGE_CANCELLED');
}

function cleanName(name: string) {
  if (Buffer.byteLength(name) > 256 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error('IMAGE_NAME_INVALID: maximum 256 UTF-8 bytes; no control characters');
  const leaf = (name.split(/[\\/]/).at(-1) || '').trim() || 'image.png';
  return redactDiagnostic(leaf);
}

export function validateImageReference(reference: ImageReference) {
  if (
    reference.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    reference.mediaType !== 'image/png' ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 1 ||
    reference.bytes > vision.maxNormalizedBytes ||
    !Number.isInteger(reference.width) ||
    !Number.isInteger(reference.height) ||
    reference.width < 1 ||
    reference.height < 1 ||
    reference.width * reference.height > vision.maxNormalizedPixels ||
    Math.max(reference.width, reference.height) > vision.maxNormalizedDimension ||
    cleanName(reference.name) !== reference.name
  )
    throw new Error('IMAGE_REFERENCE_INVALID');
}

export function validateUploadEnvelope(uploads: ImageUpload[]) {
  if (!uploads.length || uploads.length > vision.maxImages) throw new Error('IMAGE_COUNT_LIMIT');
  let encodedBytes = 0;
  for (const upload of uploads) {
    if (upload.data.length > Math.ceil(vision.maxSourceBytes / 3) * 4)
      throw new Error('IMAGE_SOURCE_LIMIT');
    cleanName(upload.name);
    encodedBytes += upload.data.length;
    if (!Number.isSafeInteger(encodedBytes)) throw new Error('IMAGE_BATCH_LIMIT');
  }
  if (encodedBytes > Math.ceil(vision.maxBatchBytes / 3) * 4 + uploads.length * 4)
    throw new Error('IMAGE_BATCH_LIMIT');
}

function detectMime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (
    bytes
      .subarray(0, 6)
      .toString('ascii')
      .match(/^GIF8[79]a$/)
  )
    return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}

function validatePngContainer(bytes: Buffer) {
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length)
      throw new Error('IMAGE_INVALID_PNG_CHUNK');
    const tag = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, end - 4);
    if (tag === 'acTL') throw new Error('IMAGE_ANIMATION_UNSUPPORTED');
    if (
      tag === 'cICP' ||
      tag === 'cHRM' ||
      (tag === 'gAMA' && (data.length !== 4 || data.readUInt32BE(0) !== 45_455))
    )
      throw new Error('IMAGE_COLOR_PROFILE_UNSUPPORTED');
    offset = end;
    if (tag === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== bytes.length) throw new Error('IMAGE_INVALID_PNG_END');
}

export async function normalizeImage(
  upload: ImageUpload,
  signal?: AbortSignal,
): Promise<PreparedImage> {
  cancelled(signal);
  if (!vision.sourceMimeTypes.includes(upload.mediaType) || !upload.data)
    throw new Error('IMAGE_SOURCE_LIMIT_OR_MIME');
  const bytes = Buffer.from(upload.data, 'base64');
  if (
    bytes.length > vision.maxSourceBytes ||
    bytes.toString('base64') !== upload.data ||
    !bytes.length
  )
    throw new Error('IMAGE_BASE64_INVALID_OR_TOO_LARGE');
  if (detectMime(bytes) !== upload.mediaType) throw new Error('IMAGE_MIME_MISMATCH');
  if (upload.mediaType === 'image/png') validatePngContainer(bytes);
  if (
    (upload.mediaType === 'image/jpeg' && !bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) ||
    (upload.mediaType === 'image/gif' && bytes.at(-1) !== 0x3b) ||
    (upload.mediaType === 'image/webp' && bytes.readUInt32LE(4) + 8 !== bytes.length)
  )
    throw new Error('IMAGE_CONTAINER_TRUNCATED_OR_TRAILING');
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(bytes, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: vision.maxSourcePixels,
      sequentialRead: true,
    }).metadata();
  } catch (error) {
    throw new Error(`IMAGE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > vision.maxSourceDimension ||
    metadata.height > vision.maxSourceDimension ||
    metadata.width * metadata.height > vision.maxSourcePixels
  )
    throw new Error('IMAGE_PIXEL_LIMIT');
  if ((metadata.pages || 1) > 1) throw new Error('IMAGE_ANIMATION_UNSUPPORTED');
  if (upload.mediaType === 'image/jpeg' && (metadata.space === 'cmyk' || metadata.channels === 4))
    throw new Error('IMAGE_COLOR_PROFILE_UNSUPPORTED');
  if (metadata.icc)
    throw new Error('IMAGE_COLOR_PROFILE_UNSUPPORTED: export as unprofiled sRGB first');
  const orientedWidth = metadata.autoOrient?.width || metadata.width;
  const orientedHeight = metadata.autoOrient?.height || metadata.height;
  const scale = Math.min(
    Math.sqrt(vision.maxNormalizedPixels / (orientedWidth * orientedHeight)),
    vision.maxNormalizedDimension / Math.max(orientedWidth, orientedHeight),
    1,
  );
  const width = Math.max(1, Math.floor(orientedWidth * scale));
  const height = Math.max(1, Math.floor(orientedHeight * scale));
  cancelled(signal);
  let output: Buffer;
  try {
    output = await sharp(bytes, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: vision.maxSourcePixels,
      sequentialRead: true,
    })
      .autoOrient()
      .resize(width, height, { fit: 'fill', kernel: sharp.kernel.cubic })
      .toColourspace('srgb')
      .ensureAlpha()
      .png({ progressive: false, palette: false })
      .toBuffer();
  } catch (error) {
    throw new Error(`IMAGE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (output.length > vision.maxNormalizedBytes) throw new Error('IMAGE_REFERENCE_INVALID');
  const reference: ImageReference = {
    version: 1,
    sha256: createHash('sha256').update(output).digest('hex'),
    mediaType: 'image/png',
    bytes: output.length,
    width,
    height,
    name: cleanName(upload.name),
  };
  validateImageReference(reference);
  cancelled(signal);
  return { reference, bytes: output };
}

export class LlmImageStore {
  readonly root: string;
  private activeImports = 0;

  constructor(appData: string) {
    this.root = join(appData, 'agent-runtime', 'images-v1');
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('IMAGE_ROOT_SYMLINK');
    if (process.platform !== 'win32') await chmod(this.root, 0o700);
  }

  async import(uploads: ImageUpload[], signal?: AbortSignal) {
    validateUploadEnvelope(uploads);
    if (this.activeImports >= 2)
      throw new Error('IMAGE_IMPORT_BUSY: retry after the current import');
    this.activeImports += 1;
    try {
      const prepared: PreparedImage[] = [];
      let sourceBytes = 0;
      for (const upload of uploads) {
        sourceBytes += Buffer.from(upload.data, 'base64').length;
        if (sourceBytes > vision.maxBatchBytes) throw new Error('IMAGE_BATCH_LIMIT');
        prepared.push(await normalizeImage(upload, signal));
      }
      for (const image of prepared) await this.commit(image, signal);
      return prepared.map(({ reference }) => reference);
    } finally {
      this.activeImports -= 1;
    }
  }

  private async commit(image: PreparedImage, signal?: AbortSignal) {
    cancelled(signal);
    const destination = join(this.root, image.reference.sha256);
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(image.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    cancelled(signal);
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await rm(temporary, { force: true });
    }
    await this.read(image.reference);
  }

  async read(reference: ImageReference) {
    validateImageReference(reference);
    const path = join(this.root, reference.sha256);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)).catch(() => {
      throw new Error('IMAGE_BLOB_MISSING_OR_UNREADABLE');
    });
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== reference.bytes)
        throw new Error('IMAGE_BLOB_TAMPERED');
      const bytes = await handle.readFile();
      if (
        bytes.length !== reference.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== reference.sha256
      )
        throw new Error('IMAGE_BLOB_TAMPERED');
      const image = await sharp(bytes).metadata();
      if (
        image.format !== 'png' ||
        image.width !== reference.width ||
        image.height !== reference.height ||
        image.channels !== 4
      )
        throw new Error('IMAGE_BLOB_FACTS_MISMATCH');
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async preview(reference: ImageReference) {
    return `data:image/png;base64,${(await this.read(reference)).toString('base64')}`;
  }

  async prepare(uploads: ImageUpload[], signal?: AbortSignal): Promise<ImageUpload[]> {
    const references = await this.import(uploads, signal);
    return Promise.all(
      references.map(async (reference) => ({
        data: (await this.read(reference)).toString('base64'),
        name: reference.name,
        mediaType: reference.mediaType,
      })),
    );
  }

  async resolveRequest(
    provider: ProviderConfig,
    references: ImageReference[],
    signal?: AbortSignal,
  ) {
    if (!references.length) return [];
    const budget = resolveModel(provider).vision;
    if (!budget)
      throw new Error('IMAGE_MODEL_UNSUPPORTED: image input is not enabled for this model');
    if (
      references.length > budget.maxRequestImages ||
      references.reduce((total, reference) => total + reference.bytes, 0) >
        budget.maxRequestImageBytes
    )
      throw new Error('IMAGE_REQUEST_BUDGET: too many retained images; start a new session');
    const urls: string[] = [];
    for (const reference of references) {
      cancelled(signal);
      urls.push(await this.preview(reference));
    }
    cancelled(signal);
    return urls;
  }
}

export { vision as visionContract };
