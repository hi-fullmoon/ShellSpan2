import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, join, parse, resolve, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { CancellationRegistry } from './cancellation.ts';
import { throwIfCancelled } from './cancellation.ts';
import { portablePath } from './paths.ts';
import { rustIoDetail } from './errors.ts';

const execFileAsync = promisify(execFile);
const COMPLETE_LIMIT = 16 * 1024 * 1024;
const TEXT_LIMIT = 256 * 1024;
const completeExtensions = new Set([
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'apng',
  'tif',
  'tiff',
  'svg',
  'mp3',
  'wav',
  'ogg',
  'oga',
  'flac',
  'm4a',
  'aac',
  'opus',
  'aif',
  'aiff',
  'caf',
  'mp4',
  'webm',
  'ogv',
  'mov',
  'm4v',
  'mpg',
  'mpeg',
  'mkv',
  'pdf',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'zip',
  'doc',
  'docx',
  'xlsx',
  'pptx',
]);
const binaryExtensions = new Set([
  ...completeExtensions,
  'gz',
  'tgz',
  'tar',
  'bz2',
  'xz',
  '7z',
  'rar',
  'xls',
  'ppt',
]);

type ConflictPolicy = 'overwrite' | 'replace' | 'skip' | 'fail';
type CopyRequest = {
  sourcePaths: string[];
  destinationDirectory: string;
  conflictPolicies: ConflictPolicy[];
  operationId: string;
};

function ioDetail(error: unknown) {
  return rustIoDetail(error);
}

async function exists(path: string) {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  );
}

function extension(name: string) {
  return extname(name).slice(1).toLowerCase();
}

function decodePreview(bytes: Buffer, truncated: boolean) {
  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    const little = bytes[0] === 0xff;
    let end = bytes.length;
    if ((end - 2) % 2 && !truncated) return undefined;
    if ((end - 2) % 2) end -= 1;
    let body = Buffer.from(bytes.subarray(2, end));
    if (!little) body.swap16();
    if (
      truncated &&
      body.length >= 2 &&
      body.readUInt16LE(body.length - 2) >= 0xd800 &&
      body.readUInt16LE(body.length - 2) <= 0xdbff
    )
      body = body.subarray(0, -2);
    try {
      return new TextDecoder('utf-16le', { fatal: true }).decode(body);
    } catch {
      return undefined;
    }
  }
  if (bytes.includes(0)) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    if (!truncated) return undefined;
    for (let trim = 1; trim <= 3 && bytes.length >= trim; trim++) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -trim));
        break;
      } catch {}
    }
    if (text! === undefined) return undefined;
  }
  const characters = [...text];
  const suspicious = characters.filter((character) => {
    const code = character.codePointAt(0)!;
    return (code < 32 || (code >= 127 && code <= 159)) && !['\n', '\r', '\t'].includes(character);
  }).length;
  return suspicious > Math.max(Math.floor(characters.length / 50), 1) ? undefined : text;
}

async function extractLegacyDocument(bytes: Buffer) {
  const worker = new Worker(join(__dirname, 'doc-preview-worker.js'));
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => finish(), 5000);
      worker.once('message', (message: { text?: string }) => finish(message.text));
      worker.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      worker.once('exit', () => finish());
      worker.postMessage(bytes);
    });
  } catch {
    return undefined;
  } finally {
    await worker.terminate();
  }
}

export async function previewLocalFile(path: string) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new Error(`failed to inspect local file: ${ioDetail(error)}`);
  }
  if (metadata.isDirectory()) throw new Error('cannot preview a directory');
  const name = basename(path).trim() || 'local-file';
  const size = metadata.size;
  const complete = completeExtensions.has(extension(name));
  const limit = complete ? COMPLETE_LIMIT : TEXT_LIMIT;
  const responsePath = portablePath(path);
  if (complete && size > limit)
    return {
      path: responsePath,
      name,
      content: '',
      size,
      isText: false,
      contentEncoding: 'none',
      truncated: true,
    };
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(Math.min(size, limit + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead > limit ? limit : bytesRead);
    const truncated = size > limit || bytesRead > limit;
    let text = binaryExtensions.has(extension(name)) ? undefined : decodePreview(bytes, truncated);
    if (extension(name) === 'doc' && !truncated) {
      const body = await extractLegacyDocument(bytes);
      if (body?.trim()) text = body;
    }
    return {
      path: responsePath,
      name,
      content: text === undefined ? bytes.toString('base64') : text,
      size,
      isText: text !== undefined,
      contentEncoding: text === undefined ? 'base64' : 'utf8',
      truncated,
    };
  } catch (error) {
    throw new Error(`failed to read local file: ${ioDetail(error)}`);
  } finally {
    await handle?.close();
  }
}

export async function listLocalDirectory(value: string, home: string) {
  const target = value === '' ? home : value;
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch (error) {
    throw new Error(`failed to resolve path: ${ioDetail(error)}`);
  }
  const rootStat = await stat(canonical);
  if (!rootStat.isDirectory()) throw new Error(`path is not a directory: ${canonical}`);
  const directoryEntries = await readdir(canonical);
  const entries = [];
  for (const name of directoryEntries) {
    const path = join(canonical, name);
    const metadata = await stat(path);
    const kind = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other';
    entries.push({
      path: portablePath(path),
      name,
      kind,
      size: metadata.isDirectory() ? null : metadata.size,
      modifiedAt: Number.isFinite(metadata.mtimeMs) ? Math.floor(metadata.mtimeMs / 1000) : null,
    });
  }
  const compareName = (left: string, right: string) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right));
  entries.sort((left, right) =>
    left.kind === right.kind
      ? compareName(left.name, right.name)
      : left.kind === 'directory'
        ? -1
        : right.kind === 'directory'
          ? 1
          : compareName(left.name, right.name),
  );
  const parent = dirname(canonical);
  return {
    path: portablePath(canonical),
    parentPath: parent === canonical ? null : portablePath(parent),
    entries,
  };
}

async function sameEntry(source: string, destination: string) {
  if (resolve(source) === resolve(destination)) return true;
  try {
    return (await realpath(source)) === (await realpath(destination));
  } catch {
    return false;
  }
}

async function validateDestination(source: string, destination: string) {
  let metadata;
  try {
    metadata = await lstat(source);
  } catch (error) {
    throw new Error(`failed to stat source ${source}: ${ioDetail(error)}`);
  }
  if (!metadata.isDirectory()) return;
  const canonicalSource = await realpath(source);
  const canonicalParent = await realpath(dirname(destination));
  const normalized = join(canonicalParent, basename(destination));
  if (normalized === canonicalSource || normalized.startsWith(`${canonicalSource}${sep}`))
    throw new Error(`cannot copy directory ${source} into itself`);
}

async function copyEntry(source: string, destination: string, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  const metadata = await lstat(source);
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source)) {
      throwIfCancelled(signal);
      await copyEntry(join(source, name), join(destination, name), signal);
    }
  } else if (metadata.isSymbolicLink()) {
    await symlink(
      await readlink(source),
      destination,
      process.platform === 'win32'
        ? (await stat(source)).isDirectory()
          ? 'dir'
          : 'file'
        : undefined,
    );
  } else {
    throwIfCancelled(signal);
    await copyFile(source, destination);
  }
}

async function entryNames(directory: string) {
  return new Set(await readdir(directory));
}

function splitName(name: string): [string, string | undefined] {
  const index = name.lastIndexOf('.');
  return index > 0 ? [name.slice(0, index), name.slice(index + 1)] : [name, undefined];
}

function uniquePasteName(names: Set<string>, base: string, suffix: string) {
  if (!names.has(base)) return base;
  const [stem, extension] = splitName(base);
  for (let index = 1; ; index++) {
    const candidate = `${stem} ${suffix}${index === 1 ? '' : ` ${index}`}${extension === undefined ? '' : `.${extension}`}`;
    if (!names.has(candidate)) return candidate;
  }
}

export async function copyLocalPaths(request: CopyRequest, registry: CancellationRegistry) {
  if (!request.sourcePaths.length) throw new Error('no source paths were provided for copy');
  const controller = registry.begin(request.operationId);
  try {
    await mkdir(request.destinationDirectory, { recursive: true });
    throwIfCancelled(controller.signal);
    const names = await entryNames(request.destinationDirectory);
    if (
      request.conflictPolicies.length &&
      request.conflictPolicies.length !== request.sourcePaths.length
    )
      throw new Error('copy conflict policy count does not match source paths');
    for (let index = 0; index < request.sourcePaths.length; index++) {
      throwIfCancelled(controller.signal);
      const source = portablePath(request.sourcePaths[index]);
      const name = basename(source);
      if (!name) throw new Error(`invalid source path: ${source}`);
      const policy = request.conflictPolicies[index] ?? 'fail';
      if (names.has(name) && policy === 'skip') continue;
      if (names.has(name) && policy === 'fail')
        throw new Error(`local path already exists: ${name}`);
      const destination = join(request.destinationDirectory, name);
      if (await sameEntry(source, destination)) continue;
      await validateDestination(source, destination);
      if (
        policy === 'replace' &&
        (await exists(destination)) &&
        (await stat(destination)).isDirectory()
      )
        await rm(destination, { recursive: true, force: true });
      await copyEntry(source, destination, controller.signal);
      names.add(name);
    }
    return null;
  } finally {
    registry.finish(request.operationId, controller);
  }
}

export async function pasteLocalPaths(
  sourcePaths: string[],
  destination: string,
  suffix: string,
  signal: AbortSignal,
) {
  if (!sourcePaths.length) throw new Error('no source paths were provided for paste');
  if (!(await stat(destination).catch(() => undefined))?.isDirectory())
    throw new Error(`destination is not a directory: ${destination}`);
  const names = await entryNames(destination);
  const written: string[] = [];
  for (const value of sourcePaths) {
    throwIfCancelled(signal);
    const source = portablePath(value);
    const name = basename(source);
    if (!name) throw new Error(`invalid source path: ${source}`);
    const targetName = uniquePasteName(names, name, suffix);
    const target = join(destination, targetName);
    if (await sameEntry(source, target)) continue;
    await validateDestination(source, target);
    await copyEntry(source, target, signal);
    names.add(targetName);
    written.push(portablePath(target));
  }
  return written;
}

export async function renameLocalPath(path: string, newName: string) {
  const name = newName.trim();
  if (!name) throw new Error('new name must not be empty');
  if (name.includes('/') || name.includes('\\'))
    throw new Error('new name must not contain path separators');
  if (!(await exists(path))) throw new Error(`path does not exist: ${path}`);
  const destination = join(dirname(path), name);
  if (await exists(destination)) throw new Error(`an entry named ${name} already exists`);
  await rename(path, destination);
  return null;
}

export async function openPath(path: string, testOnly = false) {
  if (!(await exists(path))) throw new Error(`path does not exist: ${path}`);
  let canonical;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw new Error(`failed to canonicalize path: ${ioDetail(error)}`);
  }
  if (testOnly) return null;
  const [command, args] =
    process.platform === 'darwin'
      ? (['open', [canonical]] as const)
      : process.platform === 'win32'
        ? (['explorer', [canonical]] as const)
        : (['xdg-open', [canonical]] as const);
  const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => reject(new Error(`failed to open path: ${ioDetail(error)}`)));
  });
  child.unref();
  return null;
}

async function trashOne(path: string, testTrash?: string) {
  if (testTrash || process.platform === 'darwin') {
    const trash = testTrash || join(process.env.HOME || parse(path).root, '.Trash');
    await mkdir(trash, { recursive: true });
    const names = await entryNames(trash);
    const target = join(trash, uniquePasteName(names, basename(path), 'copy'));
    await rename(path, target);
  } else if (process.platform === 'win32') {
    const escaped = path.replaceAll("'", "''");
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}','OnlyErrorDialogs','SendToRecycleBin')`,
    ]);
  } else await execFileAsync('gio', ['trash', '--', path]);
}

export async function trashLocalPaths(paths: string[], signal: AbortSignal, testTrash?: string) {
  if (!paths.length) throw new Error('no paths were provided for trash');
  for (const path of paths) {
    throwIfCancelled(signal);
    try {
      await trashOne(path, testTrash);
    } catch (error) {
      throw new Error(`failed to move ${portablePath(path)} to trash: ${ioDetail(error)}`);
    }
  }
  return null;
}
