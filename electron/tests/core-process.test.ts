import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import { CoreProcessHost } from '../core-process.ts';

const binary = require('node:path').join(__dirname, 'fixtures/core-child.js');

function host(mode: string) {
  return new CoreProcessHost(process.execPath, { ...process.env, PROBE_MODE: mode }, [binary]);
}
function bounded<T>(p: Promise<T>, ms = 3000) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Probe deadline exceeded')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
test('core exit rejects pending and future calls without replay', { timeout: 5000 }, async () => {
  const h = host('exit');
  const exited = once(h, 'exit');
  try {
    await h.ready;
    await assert.rejects(bounded(h.invoke('pending')), /exited|terminal channel ended/);
    assert.equal(h.pending.size, 0);
    await assert.rejects(h.invoke('future'), /unavailable/);
    await bounded(exited);
    assert.equal(require('node:fs').existsSync(h.pipeDirectory), false);
    assert.equal(h.terminalServer.listening, false);
  } finally {
    await h.stop();
  }
});
test('protocol mismatch and truncated stdout terminate the child', { timeout: 8000 }, async () => {
  for (const mode of ['bad-version', 'truncated']) {
    const h = host(mode);
    const exited = once(h, 'exit');
    try {
      await bounded(exited);
      assert.match(
        h.failure!.message,
        mode === 'bad-version' ? /Incompatible/ : /Truncated|terminal channel ended/,
      );
      await assert.rejects(h.invoke('future'));
    } finally {
      await h.stop();
    }
  }
});
test(
  'stalled stdin and ignored SIGTERM cannot retain pending invokes or queued writes',
  { timeout: 6000 },
  async () => {
    const h = host('stalled');
    try {
      await h.ready;
      const exited = once(h, 'exit');
      const pending = Array.from({ length: 3 }, () =>
        h.invoke('blocked', { data: 'x'.repeat(4 * 1024 * 1024) }),
      );
      const results = Promise.allSettled(pending);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(h.pending.size, 3);
      const started = Date.now();
      h.fail(new Error('injected core failure'));
      assert.ok((await bounded(results, 500)).every((r) => r.status === 'rejected'));
      assert.ok(Date.now() - started < 500);
      assert.equal(h.pending.size, 0);
      const [event] = await bounded(exited);
      assert.equal(event.signal, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL');
      await assert.rejects(h.send({ type: 'request' }), /injected/);
    } finally {
      await h.stop();
    }
  },
);
test('shutdown has a hard deadline for a non-reading child', { timeout: 8000 }, async () => {
  const h = host('stalled');
  await h.ready;
  const exited = once(h, 'exit');
  await bounded(h.stop(), 6500);
  await bounded(exited);
  assert.equal(h.child.signalCode, 'SIGKILL');
});

test(
  'encoding failures reject and release pending without poisoning other requests',
  { timeout: 5000 },
  async () => {
    const h = host('echo');
    try {
      await h.ready;
      const cycle: { self?: object } = {};
      cycle.self = cycle;
      for (const args of [cycle, { value: 1n }, { value: 'x'.repeat(64 * 1024 * 1024) }]) {
        await assert.rejects(bounded(h.invoke('encode', args)));
        assert.equal(h.pending.size, 0);
      }
      assert.deepEqual(await bounded(h.invoke('echo', { value: 'valid' })), {
        ok: true,
        value: { value: 'valid' },
      });
    } finally {
      await h.stop();
    }
  },
);

test(
  'missing binary and occupied private pipe leave no Node handles or temporary directory',
  { timeout: 10000 },
  async () => {
    for (const mode of ['missing', 'bind', 'early-stop']) {
      const code = `
   const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
   const root=fs.mkdtempSync(path.join(os.tmpdir(),'shellspan-ipc-test-'));
   if(${JSON.stringify(mode)}==='bind'){fs.writeFileSync(path.join(root,'terminal'),'occupied');fs.mkdtempSync=()=>root;}
   const {CoreProcessHost}=require(${JSON.stringify(require.resolve('../core-process.js'))});
   const h=new CoreProcessHost(${JSON.stringify(mode === 'missing' ? '/missing-core-process' : process.execPath)},{...process.env,PROBE_MODE:'echo'},${JSON.stringify(mode === 'missing' ? [] : [binary])});
   h.on('failure',()=>{});
   (async()=>{if(${JSON.stringify(mode)}!=='early-stop')await h.ready.catch(()=>{});await h.stop();if(fs.existsSync(h.pipeDirectory))throw Error('pipe directory leaked');fs.rmSync(root,{recursive:true,force:true});})().catch(e=>{console.error(e);process.exitCode=1;});
  `;
      await promisify(execFile)(process.execPath, ['-e', code], { timeout: 2500 });
    }
  },
);

test(
  'terminal EOF fails a live core and readiness includes its private channel',
  { timeout: 5000 },
  async () => {
    const h = host('terminal-eof');
    h.on('failure', () => {});
    try {
      await h.ready;
      assert.ok(h.terminalSocket);
      await bounded(once(h, 'exit'));
      assert.match(h.failure!.message, /terminal channel ended/);
      await assert.rejects(h.invoke('future'));
    } finally {
      await h.stop();
    }
  },
);
test(
  'dedicated terminal pipe rejects sequence gaps and partial EOF instead of silently losing text',
  { timeout: 6000 },
  async () => {
    for (const mode of ['terminal-sequence', 'terminal-truncated']) {
      const h = host(mode);
      h.on('failure', () => {});
      try {
        await h.ready;
        await bounded(once(h, 'exit'));
        assert.match(
          h.failure!.message,
          mode === 'terminal-sequence' ? /Out-of-order/ : /Truncated/,
        );
      } finally {
        await h.stop();
      }
    }
  },
);
test(
  'mixed old core cannot silently fall back to an unbounded shared terminal channel',
  { timeout: 5000 },
  async () => {
    const h = host('missing-terminal');
    h.on('failure', () => {});
    try {
      await bounded(once(h, 'exit'));
      assert.match(h.failure!.message, /lacks a dedicated terminal/);
      await assert.rejects(h.ready);
    } finally {
      await h.stop();
    }
  },
);

test(
  'initialization progress extends inactivity deadline without opening commands; a stall still fails',
  { timeout: 5000 },
  async (t) => {
    const realSetTimeout = global.setTimeout;
    t.mock.method(global, 'setTimeout', (...[fn, ms, ...args]: Parameters<typeof setTimeout>) =>
      realSetTimeout(fn, ms === 30000 ? 500 : ms, ...args),
    );
    const progressing = host('initializing');
    let ready = false;
    progressing.ready.then(() => (ready = true));
    try {
      await new Promise((r) => realSetTimeout(r, 250));
      assert.equal(ready, false);
      assert.equal(progressing.pending.size, 0);
      await bounded(progressing.ready, 1000);
      assert.equal(progressing.startupSequence, 8);
    } finally {
      await progressing.stop();
    }
    const stalled = host('initializing-stall');
    stalled.on('failure', () => {});
    try {
      await assert.rejects(stalled.ready, /no progress/);
      assert.equal(stalled.startupSequence, 1);
    } finally {
      await stalled.stop();
    }
  },
);
