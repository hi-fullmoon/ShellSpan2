import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { downloadUpdate, installDownloadedUpdate } from '../update-download.ts';
import type { UpdateProgress, InstallUpdater } from '../update-download.ts';

class UpdaterDouble extends EventEmitter {
  autoRunAppAfterInstall = false;
  downloadUpdate: () => Promise<string[]> = async () => [];
  quitAndInstall: InstallUpdater['quitAndInstall'] = () => {};
}
test('normal download preserves total, delta bytes and callback ordering', async () => {
  const updater = new UpdaterDouble(),
    events: UpdateProgress[] = [];
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { total: 100, transferred: 25 });
    updater.emit('download-progress', { total: 100, transferred: 100 });
    return [];
  };
  await downloadUpdate(updater, (e) => events.push(e));
  assert.deepEqual(events, [
    { event: 'Started', data: { contentLength: 100 } },
    { event: 'Progress', data: { chunkLength: 25 } },
    { event: 'Progress', data: { chunkLength: 75 } },
    { event: 'Finished' },
  ]);
  assert.equal(updater.listenerCount('download-progress'), 0);
});
test('cached/zero-progress completion still starts before finishing', async () => {
  const updater = new UpdaterDouble(),
    events: UpdateProgress[] = [];
  updater.downloadUpdate = async () => [];
  await downloadUpdate(updater, (e) => events.push(e));
  assert.deepEqual(events, [
    { event: 'Started', data: { contentLength: undefined } },
    { event: 'Finished' },
  ]);
});
test('failure/cancel preserves rejection, never finishes, and removes listener', async () => {
  for (const emitted of [false, true]) {
    const updater = new UpdaterDouble(),
      events: UpdateProgress[] = [],
      error = new Error('fixture download cancelled');
    updater.downloadUpdate = async () => {
      if (emitted) updater.emit('download-progress', { total: 100, transferred: 7 });
      throw error;
    };
    await assert.rejects(
      downloadUpdate(updater, (e) => events.push(e)),
      (e) => e === error,
    );
    assert.equal(
      events.some((e) => e.event === 'Finished'),
      false,
    );
    assert.equal(updater.listenerCount('download-progress'), 0);
  }
});

test('ordinary quit does not turn a deferred update into forced relaunch', () => {
  for (const restart of [false, true]) {
    let args: Parameters<InstallUpdater['quitAndInstall']> | undefined;
    const updater: InstallUpdater = {
      autoRunAppAfterInstall: false,
      quitAndInstall(...values) {
        args = values;
      },
    };
    installDownloadedUpdate(updater, restart);
    assert.equal(updater.autoRunAppAfterInstall, restart);
    assert.deepEqual(args, [false, restart]);
  }
});

test('installation errors recover once after synchronous or asynchronous failure', async () => {
  for (const synchronous of [false, true]) {
    const updater = new UpdaterDouble();
    const error = new Error('fixture install rejected');
    const failures: Error[] = [];
    updater.quitAndInstall = () => {
      if (synchronous) throw error;
      queueMicrotask(() => updater.emit('error', error));
    };
    updater.on('error', () => {});
    installDownloadedUpdate(updater, true, (e) => failures.push(e));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(failures, [error]);
  }
});
