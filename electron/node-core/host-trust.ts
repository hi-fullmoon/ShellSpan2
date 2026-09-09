import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Client } from 'ssh2';
import type { Socket } from 'node:net';

type PresentedKey = { key: Buffer; algorithm: string; fingerprint: string };

function endpoint(host: string, port: number) {
  return port === 22 ? host : `[${host}]:${port}`;
}

function algorithm(key: Buffer) {
  if (key.length < 4) return 'unknown';
  const length = key.readUInt32BE(0);
  return key.subarray(4, 4 + length).toString('ascii');
}

function fingerprint(key: Buffer, type = algorithm(key)) {
  const label = type.includes('ed25519')
    ? 'ED25519'
    : type.includes('ecdsa')
      ? 'ECDSA'
      : type.includes('dss')
        ? 'DSA'
        : type.includes('rsa')
          ? 'RSA'
          : 'UNKNOWN';
  return `${label} SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function matchPattern(pattern: string, value: string) {
  if (pattern === value) return true;
  if (!pattern.startsWith('|1|')) return false;
  const [, , salt, digest, extra] = pattern.split('|');
  if (!salt || !digest || extra !== undefined) return false;
  const actual = createHmac('sha1', Buffer.from(salt, 'base64')).update(value).digest();
  const expected = Buffer.from(digest, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  const fields = trimmed.split(/\s+/);
  const offset = fields[0].startsWith('@') ? 1 : 0;
  if (fields.length < offset + 3) return undefined;
  return {
    patterns: fields[offset].split(','),
    type: fields[offset + 1],
    key: fields[offset + 2],
    fields,
    offset,
  };
}

export class HostTrustManager {
  readonly path: string;
  private writeQueue = Promise.resolve();

  constructor(dataDirectory: string) {
    this.path = `${dataDirectory}/known_hosts`;
  }

  async presented(
    host: string,
    port: number,
    signal?: AbortSignal,
    sock?: Socket,
  ): Promise<PresentedKey> {
    if (!host.trim() || /[\0\r\n]/.test(host)) throw new Error('host is invalid');
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const finish = (error?: Error, value?: PresentedKey) => {
        if (settled) return;
        settled = true;
        client.destroy();
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve(value!);
      };
      const aborted = () => finish(new Error('connection cancelled'));
      signal?.addEventListener('abort', aborted, { once: true });
      client.on('error', (error) => {
        if (!settled) finish(error);
      });
      client.connect({
        host: host.trim(),
        port,
        sock,
        username: 'shellspan-host-key-probe',
        readyTimeout: 5000,
        hostVerifier: (key: Buffer) => {
          const type = algorithm(key);
          finish(undefined, { key, algorithm: type, fingerprint: fingerprint(key, type) });
          return false;
        },
      });
    });
  }

  private async content() {
    return readFile(this.path, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
  }

  async check(host: string, port: number, signal?: AbortSignal, sock?: Socket) {
    const presented = await this.presented(host, port, signal, sock);
    const value = endpoint(host.trim(), port);
    let found = false;
    let matched = false;
    for (const line of (await this.content()).split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (!parsed || !parsed.patterns.some((pattern) => matchPattern(pattern, value))) continue;
      found = true;
      if (Buffer.from(parsed.key, 'base64').equals(presented.key)) matched = true;
    }
    const status = matched ? 'match' : found ? 'mismatch' : 'notFound';
    return {
      status,
      fingerprint: presented.fingerprint,
      ...(status === 'match'
        ? {}
        : {
            message:
              status === 'mismatch'
                ? `The host key for ${host}:${port} does not match the known key. This may indicate a man-in-the-middle attack.`
                : `First time connecting to ${host}:${port}. Please verify the host fingerprint before trusting it.`,
          }),
    };
  }

  async trust(host: string, port: number, expectedFingerprint: string) {
    const presented = await this.presented(host, port);
    if (!expectedFingerprint.trim())
      throw new Error('host key fingerprint confirmation is required');
    if (expectedFingerprint.trim() !== presented.fingerprint)
      throw new Error(
        `host key changed before trust confirmation: expected ${expectedFingerprint.trim()}, received ${presented.fingerprint}`,
      );
    const task = this.writeQueue.then(async () => {
      const value = endpoint(host.trim(), port);
      const retained = (await this.content())
        .split(/\r?\n/)
        .filter((line) => {
          const parsed = parseLine(line);
          return !parsed?.patterns.some((pattern) => matchPattern(pattern, value));
        })
        .filter(Boolean);
      retained.push(`${value} ${presented.algorithm} ${presented.key.toString('base64')}`);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${retained.join('\n')}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      if (process.platform !== 'win32') await chmod(this.path, 0o600);
    });
    this.writeQueue = task.catch(() => {});
    await task;
    return null;
  }

  async remove(host: string, port: number) {
    const value = endpoint(host, port);
    const task = this.writeQueue.then(async () => {
      const retained = (await this.content())
        .split(/\r?\n/)
        .filter((line) => {
          const parsed = parseLine(line);
          return !parsed?.patterns.some((pattern) => matchPattern(pattern, value));
        })
        .filter(Boolean);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, retained.length ? `${retained.join('\n')}\n` : '', {
        mode: 0o600,
      });
      await rename(temporary, this.path);
      if (process.platform !== 'win32') await chmod(this.path, 0o600);
    });
    this.writeQueue = task.catch(() => {});
    await task;
    return null;
  }

  async list() {
    const result = [];
    for (const line of (await this.content()).split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      for (const pattern of parsed.patterns) {
        if (pattern.startsWith('|')) continue;
        const match = pattern.match(/^\[(.*)\]:(\d+)$/);
        result.push({
          host: match ? match[1] : pattern,
          port: match ? Number(match[2]) : 22,
          fingerprint: fingerprint(Buffer.from(parsed.key, 'base64'), parsed.type),
          keyType: parsed.type,
        });
      }
    }
    return result;
  }

  verify(host: string, port: number, key: Buffer) {
    const value = endpoint(host, port);
    return this.content().then((content) => {
      let found = false;
      for (const line of content.split(/\r?\n/)) {
        const parsed = parseLine(line);
        if (!parsed || !parsed.patterns.some((pattern) => matchPattern(pattern, value))) continue;
        found = true;
        if (Buffer.from(parsed.key, 'base64').equals(key)) return true;
      }
      throw new Error(found ? 'HOST_KEY_MISMATCH' : 'HOST_KEY_UNKNOWN');
    });
  }
}

export { endpoint, fingerprint, matchPattern };
