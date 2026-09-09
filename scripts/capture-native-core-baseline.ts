import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { NativeHost } from '../electron/native.ts';

const execFileAsync = promisify(execFile);
const workspace = path.resolve(import.meta.dirname, '..');
const binary = path.join(
  workspace,
  'native/target/debug',
  process.platform === 'win32' ? 'shellspan-core.exe' : 'shellspan-core',
);
const outputArgument = process.argv.indexOf('--output');
const output = path.resolve(
  outputArgument >= 0 && process.argv[outputArgument + 1]
    ? process.argv[outputArgument + 1]
    : `docs/migration/baselines/native-core-${process.platform}-${process.arch}.json`,
);
const fixtureBytes = 16 * 1024 * 1024;

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summary(values: number[]) {
  return {
    samples: values.length,
    minMs: Math.min(...values),
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

async function invoke(host: NativeHost, command: string, args: object = {}) {
  const result = await host.invoke(command, args);
  assert.equal(result.ok, true, `${command}: ${JSON.stringify(result)}`);
  return result.value;
}

async function childRssBytes(host: NativeHost) {
  if (process.platform === 'win32') return null;
  const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(host.child.pid)]);
  const kibibytes = Number(stdout.trim());
  return Number.isFinite(kibibytes) ? kibibytes * 1024 : null;
}

async function terminalLatency(host: NativeHost) {
  let terminalOutput = '';
  let observedData = false;
  const eventSequence: string[] = [];
  const waiters = new Map<string, (elapsed: number) => void>();
  host.on('event', (event, payload) => {
    if (event === 'ssh-status' && payload && typeof payload === 'object' && 'status' in payload)
      eventSequence.push(`ssh-status:${String(payload.status)}`);
    if (event === 'ssh-closed') eventSequence.push('ssh-closed');
    if (event === 'ssh-session-error') eventSequence.push('ssh-session-error');
    if (!event.startsWith('ssh-data:') || typeof payload !== 'string') return;
    if (!observedData) {
      observedData = true;
      eventSequence.push('ssh-data:${sessionId}');
    }
    terminalOutput += payload;
    for (const [marker, resolve] of waiters)
      if (terminalOutput.includes(marker)) {
        waiters.delete(marker);
        resolve(performance.now());
      }
  });
  const session = (await invoke(host, 'create_local_session', { cols: 80, rows: 24 })) as {
    sessionId: string;
  };
  await invoke(host, 'mark_session_ready', { sessionId: session.sessionId });
  await invoke(host, 'write_session', { sessionId: session.sessionId, data: 'stty -echo\r' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const samples: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const marker = `SHELLSPAN_LATENCY_${index}_${randomUUID()}`;
    const started = performance.now();
    const observed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(marker);
        reject(new Error(`Terminal baseline timed out: ${marker}`));
      }, 5000);
      waiters.set(marker, (finished) => {
        clearTimeout(timer);
        resolve(finished);
      });
    });
    await invoke(host, 'write_session', {
      sessionId: session.sessionId,
      data: `printf '${marker}\\n'\r`,
    });
    samples.push((await observed) - started);
  }
  await invoke(host, 'resize_session', { sessionId: session.sessionId, cols: 100, rows: 30 });
  await invoke(host, 'close_session', { sessionId: session.sessionId });
  return { latency: summary(samples), eventSequence };
}

async function localCopyThroughput(host: NativeHost, root: string) {
  const sourceDirectory = path.join(root, 'copy-source');
  const destinationDirectory = path.join(root, 'copy-destination');
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(destinationDirectory);
  const source = path.join(sourceDirectory, 'baseline.bin');
  await fs.writeFile(source, Buffer.alloc(fixtureBytes, 0x5a));
  const started = performance.now();
  await invoke(host, 'copy_local_paths', {
    request: {
      sourcePaths: [source],
      destinationDirectory,
      conflictPolicies: [],
      operationId: randomUUID(),
    },
  });
  const elapsedMs = performance.now() - started;
  assert.equal((await fs.stat(path.join(destinationDirectory, 'baseline.bin'))).size, fixtureBytes);
  return {
    bytes: fixtureBytes,
    elapsedMs,
    mebibytesPerSecond: fixtureBytes / 1024 / 1024 / (elapsedMs / 1000),
  };
}

async function remoteTransferThroughput(host: NativeHost, root: string) {
  if (process.env.SHELLSPAN_BASELINE_SSH !== '1') return { status: 'not-configured' };
  const hostName = process.env.SHELLSPAN_E2E_SSH_HOST || '127.0.0.1';
  const port = Number(process.env.SHELLSPAN_E2E_SSH_PORT || '22222');
  const username = process.env.SHELLSPAN_E2E_SSH_USERNAME || 'shellspan';
  const password = process.env.SHELLSPAN_E2E_SSH_PASSWORD || 'shellspan-e2e';
  const key = (await invoke(host, 'check_host_key', { request: { host: hostName, port } })) as {
    fingerprint?: string;
  };
  assert.ok(key.fingerprint, 'SSH fixture did not present a fingerprint');
  await invoke(host, 'trust_host', {
    request: { host: hostName, port, expectedFingerprint: key.fingerprint },
  });
  const connection = { host: hostName, port, username, authMethod: 'password', password };
  const source = path.join(root, 'remote-baseline.bin');
  await fs.writeFile(source, Buffer.alloc(fixtureBytes, 0x33));
  const uploadStarted = performance.now();
  await invoke(host, 'upload_local_paths', {
    request: {
      ...connection,
      destinationDirectory: '/home/shellspan/upload',
      localPaths: [source],
      conflictPolicies: ['overwrite'],
      operationId: randomUUID(),
    },
  });
  const uploadMs = performance.now() - uploadStarted;
  const destination = path.join(root, 'remote-download');
  await fs.mkdir(destination);
  const downloadStarted = performance.now();
  await invoke(host, 'download_remote_paths', {
    request: {
      ...connection,
      remotePaths: ['/home/shellspan/upload/remote-baseline.bin'],
      destinationDirectory: destination,
      conflictPolicies: ['overwrite'],
      operationId: randomUUID(),
    },
  });
  const downloadMs = performance.now() - downloadStarted;
  assert.equal((await fs.stat(path.join(destination, 'remote-baseline.bin'))).size, fixtureBytes);
  return {
    status: 'captured',
    bytes: fixtureBytes,
    upload: {
      elapsedMs: uploadMs,
      mebibytesPerSecond: fixtureBytes / 1024 / 1024 / (uploadMs / 1000),
    },
    download: {
      elapsedMs: downloadMs,
      mebibytesPerSecond: fixtureBytes / 1024 / 1024 / (downloadMs / 1000),
    },
  };
}

function storageSnapshot(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      schemaVersions: database.prepare('SELECT version FROM schema_version ORDER BY version').all(),
      objects: database
        .prepare(
          "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all(),
      fixturePreferences: database
        .prepare(
          "SELECT key, value FROM preferences WHERE key LIKE 'migration.baseline.%' ORDER BY key",
        )
        .all(),
    };
  } finally {
    database.close();
  }
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shellspan-native-baseline-'));
const started = performance.now();
let host = new NativeHost(binary, {
  ...process.env,
  SHELLSPAN_HOME: temporaryRoot,
  SHELLSPAN_APP_DATA: path.join(temporaryRoot, 'app'),
  SHELLSPAN_LOG_DIR: path.join(temporaryRoot, 'logs'),
});
host.on('log', () => {});

try {
  const ready = await host.ready;
  const readyMs = performance.now() - started;
  const commandSamples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const commandStarted = performance.now();
    await invoke(host, 'list_profiles', { ignoredByBaseline: true });
    commandSamples.push(performance.now() - commandStarted);
  }
  await invoke(host, 'save_preferences', {
    entries: [['migration.baseline.unicode', '汉字']],
  });
  const preferences = (await invoke(host, 'load_preferences')) as [string, string][];
  assert.deepEqual(
    preferences.find(([key]) => key === 'migration.baseline.unicode'),
    ['migration.baseline.unicode', '汉字'],
  );
  const invalid = await host.invoke('write_session', { sessionId: 'missing', data: 1 });
  assert.deepEqual(invalid, {
    ok: false,
    error:
      'invalid args `data` for command `write_session`: invalid type: integer `1`, expected a string',
  });
  const optionalWorkspaceWireValue = await invoke(host, 'load_terminal_workspace');
  const residentSetBytes = await childRssBytes(host);
  const remoteTransfer = await remoteTransferThroughput(host, temporaryRoot);
  const terminal = await terminalLatency(host);
  const localCopy = await localCopyThroughput(host, temporaryRoot);
  await host.stop();
  const storage = storageSnapshot(path.join(temporaryRoot, '.shellspan-dev/shellspan.db'));
  const readySamples = [readyMs];
  for (let index = 1; index < 5; index += 1) {
    const probeStarted = performance.now();
    const probe = new NativeHost(binary, {
      ...process.env,
      SHELLSPAN_HOME: temporaryRoot,
      SHELLSPAN_APP_DATA: path.join(temporaryRoot, 'app'),
      SHELLSPAN_LOG_DIR: path.join(temporaryRoot, 'logs'),
    });
    probe.on('log', () => {});
    await probe.ready;
    readySamples.push(performance.now() - probeStarted);
    await probe.stop();
  }
  const baseline = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    core: ready,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model || 'unknown',
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
    },
    metrics: {
      ready: summary(readySamples),
      residentSetBytes,
      listProfiles: summary(commandSamples),
      terminalRoundTrip: terminal.latency,
      localCopy,
      remoteTransfer,
    },
    goldenBehavior: {
      extraTopLevelArgumentsIgnored: true,
      unitWireValue: null,
      optionalWorkspaceWireValue,
      unicodePreference: '汉字',
      invalidScalarResponse: invalid,
      terminalEventSequence: terminal.eventSequence,
      storage,
    },
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Captured native core baseline at ${path.relative(workspace, output)}.`);
} finally {
  await host.stop();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
