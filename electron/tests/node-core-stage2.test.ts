import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import Ajv from 'ajv';
import valuesSchema from '../contracts/v1/command-values.schema.json';
import { NodeCoreBackend } from '../node-core-backend.ts';
import { redactDiagnostic, redactValue } from '../node-core/redaction.ts';
import { expandHomePath, portablePath } from '../node-core/paths.ts';

async function fixtureBackend(testMode = true) {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage2-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  const logs = join(root, 'logs');
  const trash = join(root, 'trash');
  await Promise.all([mkdir(home), mkdir(data), mkdir(logs), mkdir(trash)]);
  const backend = new NodeCoreBackend({
    ...process.env,
    SHELLSPAN_HOME: home,
    SHELLSPAN_APP_DATA: data,
    SHELLSPAN_LOG_DIR: logs,
    SHELLSPAN_APP_VERSION: '2.0.56',
    SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
    ...(testMode
      ? {
          SHELLSPAN_NODE_CORE_TEST_MODE: '1',
          SHELLSPAN_NODE_CORE_TEST_TRASH: trash,
        }
      : {}),
  });
  await backend.ready;
  return { root, home, data, logs, trash, backend };
}

async function value(backend: NodeCoreBackend, command: string, args: object = {}) {
  const result = await backend.invoke(command, args);
  if (!result.ok) throw new Error(String(result.error));
  return result.value;
}

test(
  'Stage 2 local-fs reads, previews, sorts Unicode and keeps the event loop responsive',
  { timeout: 15000 },
  async () => {
    const fixture = await fixtureBackend();
    try {
      const source = join(fixture.root, 'source');
      await mkdir(join(source, 'folder'), { recursive: true });
      await writeFile(join(source, 'a.txt'), 'alpha 世界');
      await writeFile(join(source, '猫.txt'), 'cat');
      await writeFile(join(source, 'binary.bin'), Buffer.from([0, 1, 2]));
      await writeFile(join(fixture.home, 'tilde.txt'), 'home');
      const listing = (await value(fixture.backend, 'list_local_directory', { path: source })) as {
        path: string;
        entries: Array<{ name: string; kind: string }>;
      };
      assert.equal(listing.path, await realpath(source));
      assert.equal(listing.entries[0].name, 'folder');
      assert.deepEqual(
        listing.entries.slice(1).map((entry) => entry.name),
        ['a.txt', 'binary.bin', '猫.txt'],
      );
      assert.equal(
        await value(fixture.backend, 'read_text_file', { path: join(source, 'a.txt') }),
        'alpha 世界',
      );
      assert.equal(await value(fixture.backend, 'read_text_file', { path: '~/tilde.txt' }), 'home');
      assert.deepEqual(
        await value(fixture.backend, 'preview_local_file', { path: join(source, 'a.txt') }),
        {
          path: join(source, 'a.txt'),
          name: 'a.txt',
          content: 'alpha 世界',
          size: Buffer.byteLength('alpha 世界'),
          isText: true,
          contentEncoding: 'utf8',
          truncated: false,
        },
      );
      const binary = (await value(fixture.backend, 'preview_local_file', {
        path: join(source, 'binary.bin'),
      })) as { content: string; contentEncoding: string };
      assert.equal(binary.content, 'AAEC');
      assert.equal(binary.contentEncoding, 'base64');

      const large = join(source, 'large.mp4');
      await writeFile(large, '');
      await truncate(large, 16 * 1024 * 1024 + 1);
      const preview = (await value(fixture.backend, 'preview_local_file', { path: large })) as {
        contentEncoding: string;
        truncated: boolean;
      };
      assert.equal(preview.contentEncoding, 'none');
      assert.equal(preview.truncated, true);

      const many = join(fixture.root, 'many');
      await mkdir(many);
      await Promise.all(
        Array.from({ length: 300 }, (_, index) => writeFile(join(many, `${index}.txt`), 'x')),
      );
      const copy = fixture.backend.invoke('copy_local_paths', {
        request: {
          sourcePaths: [many],
          destinationDirectory: join(fixture.root, 'large-copy'),
          conflictPolicies: [],
          operationId: 'responsive-copy',
        },
      });
      const started = Date.now();
      const health = await value(fixture.backend, 'get_system_health');
      assert.ok(Date.now() - started < 1000);
      assert.equal(typeof health, 'object');
      assert.equal((await copy).ok, true);
    } finally {
      await fixture.backend.stop();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  'Stage 2 local-fs preserves copy conflicts, partial failure, paste, rename, open and trash',
  { timeout: 15000 },
  async () => {
    const fixture = await fixtureBackend();
    try {
      const sources = join(fixture.root, 'sources');
      const destination = join(fixture.root, 'destination');
      await Promise.all([mkdir(sources), mkdir(destination)]);
      const first = join(sources, 'report.txt');
      await writeFile(first, 'new');
      await writeFile(join(destination, 'report.txt'), 'old');
      const fail = await fixture.backend.invoke('copy_local_paths', {
        request: {
          sourcePaths: [first],
          destinationDirectory: destination,
          conflictPolicies: ['fail'],
          operationId: 'fail',
        },
      });
      assert.equal(fail.ok, false);
      assert.equal(await readFile(join(destination, 'report.txt'), 'utf8'), 'old');
      await value(fixture.backend, 'copy_local_paths', {
        request: {
          sourcePaths: [first],
          destinationDirectory: destination,
          conflictPolicies: ['overwrite'],
          operationId: 'overwrite',
        },
      });
      assert.equal(await readFile(join(destination, 'report.txt'), 'utf8'), 'new');

      const second = join(sources, 'kept.txt');
      await writeFile(second, 'kept');
      const partial = await fixture.backend.invoke('copy_local_paths', {
        request: {
          sourcePaths: [second, join(sources, 'missing.txt')],
          destinationDirectory: destination,
          conflictPolicies: [],
          operationId: 'partial',
        },
      });
      assert.equal(partial.ok, false);
      assert.equal(await readFile(join(destination, 'kept.txt'), 'utf8'), 'kept');

      const pasted = (await value(fixture.backend, 'paste_local_paths', {
        sourcePaths: [first],
        destinationDirectory: destination,
        copySuffix: '副本',
      })) as string[];
      assert.ok(pasted[0].endsWith('report 副本.txt'));
      await value(fixture.backend, 'rename_local_path', {
        path: pasted[0],
        newName: 'renamed.txt',
      });
      assert.equal((await stat(join(destination, 'renamed.txt'))).isFile(), true);
      await value(fixture.backend, 'open_path', { path: join(destination, 'renamed.txt') });
      await value(fixture.backend, 'trash_local_paths', {
        paths: [join(destination, 'renamed.txt')],
      });
      assert.equal((await stat(join(fixture.trash, 'renamed.txt'))).isFile(), true);
    } finally {
      await fixture.backend.stop();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  'copy cancellation prevents later writes and releases its registry',
  { timeout: 15000 },
  async () => {
    const fixture = await fixtureBackend();
    try {
      const source = join(fixture.root, 'cancel-source');
      await mkdir(source);
      await Promise.all(
        Array.from({ length: 1000 }, (_, index) =>
          writeFile(join(source, `${index}.txt`), 'x'.repeat(1024)),
        ),
      );
      const operation = fixture.backend.invoke('copy_local_paths', {
        request: {
          sourcePaths: [source],
          destinationDirectory: join(fixture.root, 'cancel-destination'),
          conflictPolicies: [],
          operationId: 'cancel-me',
        },
      });
      let cancelled = false;
      for (let attempt = 0; attempt < 50 && !cancelled; attempt++) {
        const result = await fixture.backend.invoke('__test_cancel_local', {
          operationId: 'cancel-me',
        });
        cancelled = result.ok && result.value === true;
        if (!cancelled) await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.equal(cancelled, true);
      const result = await operation;
      assert.equal(result.ok, false);
      assert.match(String(result.ok ? '' : result.error), /cancelled/);
      const copiedDirectory = join(fixture.root, 'cancel-destination', 'cancel-source');
      const countAfterCancel = await readdir(copiedDirectory).then(
        (entries) => entries.length,
        () => 0,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const countAfterWait = await readdir(copiedDirectory).then(
        (entries) => entries.length,
        () => 0,
      );
      assert.equal(countAfterWait, countAfterCancel);
      const retry = await fixture.backend.invoke('copy_local_paths', {
        request: {
          sourcePaths: [join(source, '0.txt')],
          destinationDirectory: join(fixture.root, 'retry-destination'),
          conflictPolicies: [],
          operationId: 'cancel-me',
        },
      });
      assert.equal(retry.ok, true);
    } finally {
      await fixture.backend.stop();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test('logs and health satisfy frozen value schemas', async () => {
  const fixture = await fixtureBackend();
  try {
    await writeFile(join(fixture.logs, 'backend.log'), 'backend line\n');
    await writeFile(join(fixture.logs, 'ignored.txt'), 'ignore');
    const logs = await value(fixture.backend, 'list_log_files');
    assert.deepEqual(
      (logs as Array<{ name: string }>).map((entry) => entry.name),
      ['backend.log'],
    );
    assert.equal(
      await value(fixture.backend, 'read_log_file', { name: 'backend.log' }),
      'backend line\n',
    );
    const health = await value(fixture.backend, 'get_system_health');
    const ajv = new Ajv({ strict: false });
    const definitions = valuesSchema.definitions;
    const validateHealth = ajv.compile({
      ...definitions.CommandValues.properties.get_system_health,
      definitions,
    });
    assert.equal(validateHealth(health), true, JSON.stringify(validateHealth.errors));
    assert.equal((health as { appInfo: { version: string } }).appInfo.version, '2.0.56');
  } finally {
    await fixture.backend.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test(
  'Petdex uses only loopback token protocol and emits stable status events',
  { timeout: 10000 },
  async () => {
    const bodies: string[] = [];
    const tokens: string[] = [];
    let rotateTokenPath = '';
    let rotateOnNextRequest = false;
    const rotatedToken = 'b'.repeat(64);
    const server = createServer((request, response) => {
      tokens.push(String(request.headers['x-petdex-update-token']));
      request.setEncoding('utf8');
      request.on('data', (chunk) => bodies.push(chunk));
      request.on('end', () => {
        void (async () => {
          if (rotateOnNextRequest) {
            rotateOnNextRequest = false;
            await writeFile(rotateTokenPath, rotatedToken);
            response.writeHead(401);
          } else response.writeHead(200);
          response.end();
        })();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const fixture = await fixtureBackend();
    await fixture.backend.stop();
    const token = 'a'.repeat(64);
    await mkdir(join(fixture.home, '.petdex/runtime'), { recursive: true });
    rotateTokenPath = join(fixture.home, '.petdex/runtime/update-token');
    await writeFile(rotateTokenPath, token);
    const backend = new NodeCoreBackend({
      ...process.env,
      SHELLSPAN_HOME: fixture.home,
      SHELLSPAN_APP_DATA: fixture.data,
      SHELLSPAN_LOG_DIR: fixture.logs,
      SHELLSPAN_NODE_CORE_TEST_MODE: '1',
      SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
      SHELLSPAN_PETDEX_TEST_ENDPOINT: `http://127.0.0.1:${address.port}/state`,
    });
    try {
      await backend.ready;
      const statusEvent = once(backend, 'event');
      assert.equal(await value(backend, 'petdex_set_enabled', { enabled: true }), 'notDetected');
      assert.deepEqual(await statusEvent, ['petdex-status', 'notDetected']);
      assert.equal(await value(backend, 'petdex_test_connection'), 'connected');
      assert.equal(await value(backend, 'petdex_get_status'), 'connected');
      assert.deepEqual(tokens, [token, token]);
      assert.match(bodies.join(''), /"state":"idle"/);
      assert.match(bodies.join(''), /"state":"waving","duration":1200/);
      assert.equal(await value(backend, 'petdex_set_enabled', { enabled: true }), 'connected');
      rotateOnNextRequest = true;
      assert.equal(await value(backend, 'petdex_test_connection'), 'connected');
      assert.deepEqual(tokens.slice(-2), [token, rotatedToken]);
      await writeFile(rotateTokenPath, 'invalid');
      assert.equal(await value(backend, 'petdex_test_connection'), 'connectionError');
      assert.equal(tokens.length, 4);
    } finally {
      await backend.stop();
      server.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test('Node diagnostics redact nested and reconstructed secret markers', () => {
  assert.equal(
    redactDiagnostic('Authorization: Bearer abc.secret'),
    'Authorization: Bearer [REDACTED]',
  );
  assert.deepEqual(redactValue({ password: 'value', nested: { apiKey: 'token' }, safe: 'ok' }), {
    password: '[REDACTED]',
    nested: { apiKey: '[REDACTED]' },
    safe: 'ok',
  });
});

test('portable paths preserve long Windows and UNC identities without truncation', () => {
  const long = `C:\\Users\\shellspan\\${'nested\\'.repeat(80)}file.txt`;
  assert.equal(portablePath(long), long.replaceAll('\\', '/'));
  assert.equal(portablePath('\\\\server\\share\\目录'), '//server/share/目录');
  assert.equal(expandHomePath('~/file.txt', '/Users/test'), '/Users/test/file.txt');
});
