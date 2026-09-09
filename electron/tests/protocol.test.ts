import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { encode, Decoder } from '../protocol.ts';
import { validateCommand, byName } from '../validation.ts';

test('framing preserves UTF-8, binary boundaries and concatenated messages', () => {
  const expected = [
    { type: 'event', payload: '汉字\u001b[31m\n' },
    { id: 2, ok: false, error: { type: 'Other', payload: { message: 'cancelled' } } },
  ];
  const bytes = Buffer.concat(expected.map(encode));
  for (const size of [1, 2, 3, 4, 7, bytes.length]) {
    const output: unknown[] = [];
    const decoder = new Decoder((value) => output.push(value));
    for (let i = 0; i < bytes.length; i += size) decoder.push(bytes.subarray(i, i + size));
    decoder.finish();
    assert.deepEqual(output, expected);
  }
});
test('rejects oversized, empty, malformed and truncated frames', () => {
  for (const header of [Buffer.from([255, 255, 255, 255]), Buffer.alloc(4)])
    assert.throws(() => new Decoder(() => {}).push(header));
  const decoder = new Decoder(() => {});
  decoder.push(encode({ x: 1 }).subarray(0, 6));
  assert.throws(() => decoder.finish());
  assert.throws(() => new Decoder(() => {}).push(Buffer.from([0, 0, 0, 1, 0])));
});
test('all baseline commands have one validated entry with camelCase arguments', () => {
  assert.equal(byName.size, 141);
  for (const value of byName.values())
    for (const name of Object.keys(value.properties || {}))
      assert.match(name, /^[a-z][a-zA-Z0-9]*$/);
  validateCommand('resize_session', { sessionId: 's', cols: 80, rows: 24 });
  validateCommand('pick_local_folder', {});
  assert.throws(() => validateCommand('exec', {}));
  assert.throws(() => validateCommand('resize_session', { sessionId: 's', cols: -1, rows: 24 }));
  assert.throws(() => validateCommand('write_session', { sessionId: 's', data: 1 }));
  assert.doesNotThrow(() => validateCommand('list_profiles', { path: '/tmp' })); // Fixed B ignores extra top-level keys.
});
