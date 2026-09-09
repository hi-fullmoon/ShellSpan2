import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NodeCoreBackend } from '../node-core-backend.ts';

function bounded<T>(promise: Promise<T>, ms = 3000) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Node Core test deadline exceeded')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test(
  'standalone Node Core completes ready, request, response, event and stop',
  { timeout: 5000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-node-core-'));
    const fixture = join(root, 'canary.txt');
    const invalidFixture = join(root, 'invalid.bin');
    await writeFile(fixture, 'deterministic 世界\n');
    await writeFile(invalidFixture, Buffer.from([0xff]));
    const backend = new NodeCoreBackend({
      ...process.env,
      SHELLSPAN_HOME: root,
      SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
      SHELLSPAN_NODE_CORE_TEST_MODE: '1',
    });
    try {
      assert.deepEqual(await bounded(backend.ready), {
        type: 'ready',
        protocol: 1,
        terminalChannel: true,
      });
      assert.deepEqual(await bounded(backend.invoke('read_text_file', { path: fixture })), {
        ok: true,
        value: 'deterministic 世界\n',
      });
      assert.deepEqual(await backend.validate('read_text_file', { path: fixture }), {
        ok: true,
        value: null,
      });
      assert.deepEqual(await backend.invoke('read_text_file', {}), {
        ok: false,
        error: 'Invalid arguments for read_text_file: / missing required property path',
      });
      assert.deepEqual(await backend.invoke('read_text_file', { path: invalidFixture }), {
        ok: false,
        error: `failed to read file ${invalidFixture}: stream did not contain valid UTF-8`,
      });
      const event = once(backend, 'event');
      assert.deepEqual(await backend.invoke('__test_event'), { ok: true, value: null });
      assert.deepEqual(await bounded(event), ['desktop-resized', null]);
      const stopped = once(backend, 'stopped');
      await bounded(backend.stop());
      await bounded(stopped);
    } finally {
      await backend.stop();
      assert.equal(
        await stat(join(root, '.shellspan-dev')).then(
          () => true,
          () => false,
        ),
        false,
      );
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'Node Core preserves framed backpressure for a multi-megabyte response',
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-node-core-large-'));
    const fixture = join(root, 'large.txt');
    const content = '0123456789abcdef'.repeat(256 * 1024);
    await writeFile(fixture, content);
    const backend = new NodeCoreBackend({
      ...process.env,
      SHELLSPAN_HOME: root,
      SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
    });
    try {
      const result = await bounded(backend.invoke('read_text_file', { path: fixture }), 8000);
      assert.deepEqual(result, { ok: true, value: content });
      assert.equal(backend.host.pending.size, 0);
    } finally {
      await backend.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an abnormal Node Core exit rejects pending and future requests',
  { timeout: 5000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-node-core-crash-'));
    const backend = new NodeCoreBackend({
      ...process.env,
      SHELLSPAN_HOME: root,
      SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
      SHELLSPAN_NODE_CORE_TEST_MODE: '1',
    });
    backend.on('failure', () => {});
    await backend.ready;
    const exit = once(backend, 'exit');
    await assert.rejects(bounded(backend.invoke('__test_crash')), /exited|terminal channel ended/);
    const [info] = await bounded(exit);
    assert.equal(info.expected, false);
    assert.notEqual(info.code, 0);
    assert.equal(backend.host.pending.size, 0);
    await assert.rejects(backend.invoke('read_text_file', { path: '/future' }), /unavailable/);
    await backend.stop();
    await rm(root, { recursive: true, force: true });
  },
);

test(
  'a malformed Node Core request fails closed at the process boundary',
  { timeout: 5000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-node-core-protocol-'));
    const backend = new NodeCoreBackend({
      ...process.env,
      SHELLSPAN_HOME: root,
      SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
    });
    backend.on('failure', () => {});
    await backend.ready;
    const exit = once(backend, 'exit');
    await backend.host.send({ type: 'invalid-protocol-record' });
    const [info] = await bounded(exit);
    assert.equal(info.expected, false);
    assert.notEqual(info.code, 0);
    await assert.rejects(backend.invoke('read_text_file', { path: '/future' }), /unavailable/);
    await backend.stop();
    await rm(root, { recursive: true, force: true });
  },
);
