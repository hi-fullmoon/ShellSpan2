import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import type { PreloadBridge } from '../preload.ts';

type Delivery = (event: unknown, name: string, payload: unknown, id?: number) => void;
test('preload exposes explicit commands and subscriptions never leak Electron event objects', async () => {
  let bridge!: PreloadBridge & { ipcRenderer?: unknown };
  let delivery!: Delivery;
  const calls: unknown[][] = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, value: PreloadBridge) {
        assert.equal(name, 'shellspan');
        bridge = value;
      },
    },
    ipcRenderer: {
      send(...args: unknown[]) {
        calls.push(args);
      },
      on(name: string, callback: Delivery) {
        assert.equal(name, 'desktop:event');
        delivery = callback;
      },
      invoke(...args: unknown[]) {
        calls.push(args);
        return Promise.resolve({
          ok: false,
          error: { type: 'Other', payload: { message: 'cancelled' } },
        });
      },
    },
    webUtils: { getPathForFile: () => '/tmp/file' },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../preload.cjs'), 'utf8'), {
    require: (name: string) => {
      assert.equal(name, 'electron');
      return electron;
    },
    console,
  });
  for (const event of ['desktop-exit', 'desktop-restart', 'ssh-data:', 'bogus'])
    assert.throws(() => bridge.on(event, () => {}));
  assert.equal(Object.keys(bridge.commands).length, 141);
  assert.equal(bridge.commands.exec, undefined);
  assert.equal(bridge.ipcRenderer, undefined);
  const args = { sessionId: 's', data: '汉字' };
  const result = await bridge.commands.write_session(args);
  assert.deepEqual(calls, [['desktop:command', 'write_session', args]]);
  assert.equal(result.error.type, 'Other');
  const first: unknown[][] = [];
  const second: unknown[] = [];
  const stop = bridge.on('ssh-data:s', (...values) => first.push(values));
  const stop2 = bridge.on('ssh-data:s', (value) => second.push(value));
  delivery({ sender: { privileged: true } }, 'ssh-data:s', 'one');
  stop();
  delivery({}, 'ssh-data:s', 'two');
  stop2();
  delivery({}, 'ssh-data:s', 'three', 42);
  assert.deepEqual(calls.at(-1), ['desktop:terminal-ack', 42]);
  assert.deepEqual(first, [['one']]);
  assert.deepEqual(second, ['one', 'two']);
});
