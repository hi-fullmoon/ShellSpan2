import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import Ajv from 'ajv';
import commandValuesSchema from '../contracts/v1/command-values.schema.json';
import type { NodeCoreEventSender } from './events.ts';
import { projectAgentRecord } from './agent-projection.ts';
import type { AgentEvent, AgentSessionRecord } from './agent-types.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SESSIONS = 1_000;
const MAX_LOG_BYTES = 256 * 1024 * 1024;
const validateAgentEvent = new Ajv({ strict: false, allErrors: true }).compile({
  $ref: '#/definitions/AgentSessionEvent',
  definitions: commandValuesSchema.definitions,
});

export function validateAgentId(value: string, label: string) {
  if (!ID.test(value)) throw new Error(`invalid ${label}`);
}

function validateLoaded(events: AgentEvent[], expectedSessionId: string) {
  if (!events.length) throw new Error('empty Agent Session log');
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (
      event.version !== 5 ||
      event.sessionId !== expectedSessionId ||
      event.seq !== index ||
      !Number.isSafeInteger(event.timeUnixMs) ||
      event.timeUnixMs < 1 ||
      (index > 0 && event.timeUnixMs < events[index - 1].timeUnixMs) ||
      typeof event.type !== 'string'
    )
      throw new Error(`invalid Agent Session event at sequence ${index}`);
    if (!validateAgentEvent(event))
      throw new Error(
        `invalid Agent Session event at sequence ${index}: ${JSON.stringify(validateAgentEvent.errors)}`,
      );
  }
  if (events[0].type !== 'session/created' || events[1]?.type !== 'agent/created')
    throw new Error('Agent Session log has an invalid creation prefix');
}

function encoded(events: AgentEvent[]) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

type RecoveryNotice = {
  fileName: string;
  action: 'badTailDiscarded' | 'corruptLogQuarantined';
  reason: string;
  evidenceFileName: string;
  recordedAtUnixMs: number;
};

export class AgentEventStore {
  readonly activeRoot: string;
  readonly archiveRoot: string;
  readonly artifactRoot: string;
  readonly ready: Promise<void>;
  readonly sessions = new Map<string, AgentSessionRecord>();
  readonly recoveryNotices: RecoveryNotice[] = [];
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    appData: string,
    private readonly events: NodeCoreEventSender,
  ) {
    const root = join(appData, 'agent-runtime');
    this.activeRoot = join(root, 'sessions-v5');
    this.archiveRoot = join(root, 'sessions-v5-archive');
    this.artifactRoot = join(root, 'artifacts-v1');
    this.ready = this.open();
  }

  private async open() {
    await Promise.all([
      mkdir(this.activeRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.archiveRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.artifactRoot, { recursive: true, mode: 0o700 }),
    ]);
    await this.loadRoot(this.archiveRoot, true);
    await this.loadRoot(this.activeRoot, false);
    if (this.sessions.size > MAX_SESSIONS)
      throw new Error('Agent session store reached its Session limit');
  }

  private async loadRoot(root: string, archived: boolean) {
    const names = (await readdir(root)).filter((name) => name.endsWith('.jsonl')).sort();
    for (const name of names) await this.loadFile(join(root, name), archived);
  }

  private async loadFile(path: string, archived: boolean) {
    const sessionId = basename(path, '.jsonl');
    if (!ID.test(sessionId)) return;
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const events: AgentEvent[] = [];
    let badIndex = -1;
    let reason = '';
    for (let index = 0; index < lines.length; index++) {
      try {
        events.push(JSON.parse(lines[index]) as AgentEvent);
      } catch (error) {
        badIndex = index;
        reason = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    const timestamp = Date.now();
    if (badIndex >= 0) {
      const evidence = `${basename(path)}.recovery-${timestamp}`;
      await writeFile(join(this.activeRoot, evidence), raw, { mode: 0o600 });
      if (badIndex === lines.length - 1 && events.length >= 2) {
        await writeFile(path, encoded(events), { mode: 0o600 });
        this.recoveryNotices.push({
          fileName: basename(path),
          action: 'badTailDiscarded',
          reason,
          evidenceFileName: evidence,
          recordedAtUnixMs: timestamp,
        });
      } else {
        await rename(path, join(this.activeRoot, `${basename(path)}.corrupt-${timestamp}`));
        this.recoveryNotices.push({
          fileName: basename(path),
          action: 'corruptLogQuarantined',
          reason,
          evidenceFileName: evidence,
          recordedAtUnixMs: timestamp,
        });
        return;
      }
    }
    try {
      validateLoaded(events, sessionId);
      projectAgentRecord({ events, archived, path });
    } catch (error) {
      const evidence = `${basename(path)}.recovery-${timestamp}`;
      await writeFile(join(this.activeRoot, evidence), raw, { mode: 0o600 });
      await rename(path, join(this.activeRoot, `${basename(path)}.corrupt-${timestamp}`));
      this.recoveryNotices.push({
        fileName: basename(path),
        action: 'corruptLogQuarantined',
        reason: error instanceof Error ? error.message : String(error),
        evidenceFileName: evidence,
        recordedAtUnixMs: timestamp,
      });
      return;
    }
    if (this.sessions.has(sessionId))
      throw new Error(`duplicate active and archived Agent Session: ${sessionId}`);
    this.sessions.set(sessionId, { events, archived, path });
  }

  private queue<T>(sessionId: string, operation: () => Promise<T>) {
    const previous = this.queues.get(sessionId) || Promise.resolve();
    const task = previous.then(operation);
    const tail = task.catch(() => {});
    this.queues.set(sessionId, tail);
    return task.finally(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
    });
  }

  record(sessionId: string) {
    validateAgentId(sessionId, 'sessionId');
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error('Agent session was not found');
    return record;
  }

  async create(request: Record<string, unknown>) {
    await this.ready;
    const sessionId = String(request.sessionId);
    validateAgentId(sessionId, 'sessionId');
    if (this.sessions.has(sessionId)) throw new Error('Agent session already exists');
    if (this.sessions.size >= MAX_SESSIONS)
      throw new Error('Agent session store reached its Session limit');
    const now = Math.max(1, Date.now());
    const data = structuredClone(request);
    delete data.sessionId;
    const events: AgentEvent[] = [
      { version: 5, sessionId, seq: 0, timeUnixMs: now, type: 'session/created', data },
      {
        version: 5,
        sessionId,
        seq: 1,
        timeUnixMs: now,
        type: 'agent/created',
        data: {
          agentId: sessionId,
          ...(request.parentSessionId ? { parentAgentId: request.parentSessionId } : {}),
        },
      },
    ];
    const path = join(this.activeRoot, `${sessionId}.jsonl`);
    await writeFile(path, encoded(events), { flag: 'wx', mode: 0o600 });
    const record = { events, archived: false, path };
    this.sessions.set(sessionId, record);
    for (const event of events) await this.events.emit('agent-runtime-session-event', event);
    return projectAgentRecord(record);
  }

  append(
    sessionId: string,
    payloads: Array<{
      type: string;
      data?: Record<string, unknown>;
      turnId?: string;
      stepId?: string;
    }>,
  ) {
    if (!payloads.length) throw new Error('Agent Session append batch cannot be empty');
    return this.queue(sessionId, async () => {
      const record = this.record(sessionId);
      if (record.archived) throw new Error('archived Agent Session logs are read-only');
      let now = Math.max(Date.now(), record.events.at(-1)?.timeUnixMs || 1);
      const events = payloads.map(
        (payload, offset): AgentEvent => ({
          version: 5,
          sessionId,
          seq: record.events.length + offset,
          timeUnixMs: now++,
          ...(payload.turnId ? { turnId: payload.turnId } : {}),
          ...(payload.stepId ? { stepId: payload.stepId } : {}),
          type: payload.type,
          ...(payload.data ? { data: structuredClone(payload.data) } : {}),
        }),
      );
      for (const event of events)
        if (!validateAgentEvent(event))
          throw new Error(
            `invalid Agent Session event: ${JSON.stringify(validateAgentEvent.errors)}`,
          );
      const candidate = { ...record, events: [...record.events, ...events] };
      projectAgentRecord(candidate);
      const bytes = Buffer.byteLength(encoded(events));
      const current = await stat(record.path);
      if (current.size + bytes > MAX_LOG_BYTES)
        throw new Error('Agent Session log exceeds the storage boundary');
      const handle = await open(record.path, 'a', 0o600);
      try {
        await handle.writeFile(encoded(events));
        await handle.sync();
      } finally {
        await handle.close();
      }
      record.events.push(...events);
      for (const event of events) await this.events.emit('agent-runtime-session-event', event);
      return { events, snapshot: projectAgentRecord(record) };
    });
  }

  async archive(sessionId: string) {
    await this.ready;
    return this.queue(sessionId, async () => {
      const record = this.record(sessionId);
      if (record.archived) return projectAgentRecord(record);
      const destination = join(this.archiveRoot, `${sessionId}.jsonl`);
      await rename(record.path, destination);
      record.path = destination;
      record.archived = true;
      return projectAgentRecord(record);
    });
  }

  async storeArtifact(
    sessionId: string,
    title: string,
    kind: string,
    mediaType: string,
    body: Buffer,
  ) {
    validateAgentId(sessionId, 'sessionId');
    const artifactId = randomUUID();
    const sha256 = createHash('sha256').update(body).digest('hex');
    const metadata = {
      artifactId,
      kind,
      title: title.slice(0, 512),
      mediaType,
      sha256,
      sizeBytes: body.length,
      sensitivity: 'sensitiveRedacted' as const,
      createdAtUnixMs: Date.now(),
    };
    await writeFile(join(this.artifactRoot, `${sessionId}.${artifactId}.bin`), body, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(
      join(this.artifactRoot, `${sessionId}.${artifactId}.json`),
      JSON.stringify(metadata),
      { flag: 'wx', mode: 0o600 },
    );
    return metadata;
  }

  async artifact(sessionId: string, artifactId: string, maxBytes: number) {
    validateAgentId(sessionId, 'sessionId');
    validateAgentId(artifactId, 'artifactId');
    const metadata = JSON.parse(
      await readFile(join(this.artifactRoot, `${sessionId}.${artifactId}.json`), 'utf8'),
    ) as Record<string, unknown>;
    const body = await readFile(join(this.artifactRoot, `${sessionId}.${artifactId}.bin`));
    const limit = Math.max(0, Math.min(maxBytes, 8 * 1024 * 1024));
    return {
      metadata,
      bodyBase64: body.subarray(0, limit).toString('base64'),
      truncated: body.length > limit,
    };
  }

  async stop() {
    await Promise.allSettled([...this.queues.values()]);
  }
}
