import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { validateProviderId } from './llm-catalog.ts';

export type ConversionResult = {
  source: string;
  destination: string;
  events: number;
  status: 'converted' | 'alreadyConverted';
};

function replaceExtension(path: string, extension: string) {
  return path.slice(0, path.length - extname(path).length) + `.${extension}`;
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function providerDescriptors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(providerDescriptors);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, 'providerId') && Object.hasOwn(object, 'model')) {
    const result: Record<string, unknown> = {
      ...object,
      routeId: object.providerId,
      modelId: object.model,
    };
    delete result.providerId;
    delete result.model;
    delete result.profile;
    delete result.retryPolicy;
    delete result.providerKind;
    delete result.baseUrl;
    delete result.requiresApiKey;
    return result;
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, providerDescriptors(entry)]),
  );
}

function validImageReference(value: unknown) {
  const image = value as Record<string, unknown>;
  return (
    image?.version === 1 &&
    typeof image.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(image.sha256) &&
    image.mediaType === 'image/png' &&
    typeof image.bytes === 'number' &&
    image.bytes > 0 &&
    image.bytes <= 5_242_880 &&
    typeof image.width === 'number' &&
    typeof image.height === 'number' &&
    image.width > 0 &&
    image.height > 0 &&
    image.width * image.height <= 1_048_576 &&
    Math.max(image.width, image.height) <= 2048 &&
    typeof image.name === 'string' &&
    image.name === (image.name.split(/[\\/]/).at(-1) || '').trim() &&
    image.name.length > 0 &&
    Buffer.byteLength(image.name) <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(image.name)
  );
}

export function validateSessionEvents(events: Array<Record<string, unknown>>, version = 5) {
  if (!events.length || events[0].type !== 'session/created')
    throw new Error('MIGRATION_V5_VALIDATION: session event log must start with session/created');
  let sequence = -1;
  const calls = new Set<string>();
  for (const event of events) {
    if (event.version !== version) throw new Error(`MIGRATION_EXPECTED_V${version}`);
    if (!Number.isSafeInteger(event.seq) || (event.seq as number) <= sequence)
      throw new Error('MIGRATION_INVALID_SEQUENCE');
    sequence = event.seq as number;
    const data = (event.data || {}) as Record<string, unknown>;
    if (event.type === 'request/header') {
      const snapshot = data.snapshot;
      const digest = data.snapshotDigest;
      if (snapshot && digest !== sha256(JSON.stringify(snapshot)))
        throw new Error('MIGRATION_V5_VALIDATION: snapshot digest mismatch');
    }
    if (event.type === 'tool/call') {
      const call = data.call as Record<string, unknown> | undefined;
      if (typeof call?.callId === 'string') calls.add(call.callId);
    }
    if (event.type === 'tool/result' || event.type === 'tool/approval') {
      if (typeof data.callId !== 'string' || !calls.has(data.callId))
        throw new Error(
          event.type === 'tool/result'
            ? 'MIGRATION_ORPHAN_TOOL_RESULT'
            : 'MIGRATION_ORPHAN_APPROVAL',
        );
    }
    if (event.type === 'user/message') {
      const message = data.message as Record<string, unknown> | undefined;
      if (Array.isArray(message?.images) && !message.images.every(validImageReference))
        throw new Error('MIGRATION_INVALID_IMAGE: IMAGE_REFERENCE_INVALID');
    }
  }
}

function parseEvents(raw: string, expectedVersion: number) {
  const events: Array<Record<string, unknown>> = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`MIGRATION_INVALID_EVENT line ${index + 1}: ${errorText(error)}`);
    }
    if (event.version !== expectedVersion)
      throw new Error(`MIGRATION_EXPECTED_V${expectedVersion} line ${index + 1}`);
    events.push(event);
  }
  return events;
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function convertV4ToV5(
  source: string,
  destination: string,
): Promise<ConversionResult> {
  if (source === destination) throw new Error('MIGRATION_SOURCE_MUST_BE_PRESERVED');
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const lockPath = replaceExtension(source, 'migration.lock');
  const backup = replaceExtension(destination, 'v4.backup.jsonl');
  if (await exists(destination)) {
    const events = parseEvents(await readFile(destination, 'utf8'), 5);
    validateSessionEvents(events);
    if (!(await exists(backup))) throw new Error('MIGRATION_BACKUP_MISSING');
    await rm(lockPath, { force: true });
    return { source, destination, events: events.length, status: 'alreadyConverted' };
  }
  let marker;
  try {
    marker = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    throw new Error(`MIGRATION_BUSY: ${errorText(error)}`);
  }
  try {
    await marker.writeFile('preparing');
    await marker.sync();
  } catch (error) {
    throw new Error(`MIGRATION_MARKER: ${errorText(error)}`);
  } finally {
    await marker.close();
  }
  try {
    const sourceMetadata = await lstat(source);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink())
      throw new Error('MIGRATION_SOURCE: source must be a regular file');
    if (!(await exists(backup))) {
      await copyFile(source, backup, 0x1 /* COPYFILE_EXCL */);
      const backupHandle = await open(backup, 'r');
      await backupHandle.sync();
      await backupHandle.close();
    }
    const events = parseEvents(await readFile(source, 'utf8'), 4).map((input) => {
      const event = structuredClone(input);
      event.version = 5;
      const data = (event.data || {}) as Record<string, unknown>;
      const request = event.type === 'request/header' || event.type === 'request/start';
      const providerId = request ? data.providerId : undefined;
      const model = request ? data.model : undefined;
      event.data = providerDescriptors(data);
      const migratedData = event.data as Record<string, unknown>;
      if (request) {
        delete migratedData.routeId;
        delete migratedData.modelId;
        migratedData.providerId = providerId;
        migratedData.model = model;
      }
      if (event.type === 'request/header') {
        const snapshot = { status: 'legacyUnknown' };
        migratedData.snapshotDigest = sha256(JSON.stringify(snapshot));
        migratedData.snapshot = snapshot;
      }
      if (event.type === 'assistant/message' && !Object.hasOwn(migratedData, 'replay'))
        migratedData.replay = { status: 'legacyUnknown', archivedProviderItems: true };
      return event;
    });
    validateSessionEvents(events);
    const temporary = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
    const output = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
    await writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
    const temporaryHandle = await open(temporary, 'r');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    try {
      await link(temporary, destination);
    } catch (error) {
      throw new Error(`MIGRATION_PUBLISH: ${errorText(error)}`);
    } finally {
      await rm(temporary, { force: true });
    }
    const directoryHandle = await open(parent, 'r').catch(() => undefined);
    await directoryHandle?.sync().catch(() => {});
    await directoryHandle?.close();
    await rm(lockPath, { force: true });
    return { source, destination, events: events.length, status: 'converted' };
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function listSessionMigrations(appData: string) {
  const root = join(appData, 'agent-runtime');
  const oldRoot = join(root, 'sessions-v4');
  const newRoot = join(root, 'sessions-v5');
  const entries = await readdir(oldRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(async (entry) => {
        const sessionId = entry.name.slice(0, -'.jsonl'.length);
        validateProviderId(sessionId);
        const status = (await exists(join(newRoot, `${sessionId}.jsonl`)))
          ? 'converted'
          : (await exists(join(oldRoot, `${sessionId}.migration.lock`)))
            ? 'failed'
            : 'pending';
        return { sessionId, status };
      }),
  );
}
