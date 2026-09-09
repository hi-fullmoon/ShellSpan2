import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TerminalFlow } from '../terminal-flow.ts';

test('renderer credits bound terminal IPC and only known deliveries release backpressure', () => {
  const sent: Parameters<TerminalFlow['send']>[] = [];
  let pauses = 0,
    resumes = 0;
  const f = new TerminalFlow(
    (...v) => sent.push(v),
    () => pauses++,
    () => resumes++,
    100,
    40,
  );
  f.push('ssh-data:a', 'x'.repeat(60));
  f.push('ssh-data:b', 'x'.repeat(60));
  assert.equal(pauses, 1);
  assert.equal(f.bytes, 120);
  f.ack(999);
  // @ts-expect-error IPC can supply a string; it must never release numeric credits.
  f.ack('1');
  assert.equal(f.bytes, 120);
  f.ack(1);
  assert.equal(resumes, 0);
  f.ack(1);
  assert.equal(f.bytes, 60);
  f.ack(2);
  assert.equal(resumes, 1);
  assert.equal(f.pending.size, 0);
  f.push('ssh-closed', { sessionId: 'a' });
  assert.equal(sent.at(-1)![0], 'ssh-closed');
  f.reset();
  assert.equal(f.bytes, 0);
});
test('main-frame reload drops old credits, holds reading until new preload and ignores stale acknowledgements', () => {
  const ids: number[] = [];
  let pauses = 0,
    resumes = 0;
  const f = new TerminalFlow(
    (_e, _p, id) => ids.push(id),
    () => pauses++,
    () => resumes++,
    100,
    40,
  );
  f.push('ssh-data:a', 'x'.repeat(120));
  const old = ids[0];
  f.navigation();
  assert.equal(f.bytes, 0);
  f.ack(old);
  assert.equal(resumes, 0);
  f.ready();
  assert.equal(resumes, 1);
  f.push('ssh-data:b', 'x'.repeat(120));
  assert.notEqual(ids[1], old);
  f.ack(old);
  assert.equal(f.bytes, 120);
  f.ack(ids[1]);
  assert.equal(resumes, 2);
});
