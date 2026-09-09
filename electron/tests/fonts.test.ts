import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fontResponse } from '../fonts.ts';

test('font scheme reads only the two fixed macOS system font resources', async () => {
  const paths: string[] = [];
  const read = async (p: string) => {
    paths.push(p);
    return Buffer.from('font fixture');
  };
  for (const name of ['mono-regular', 'mono-italic']) {
    const r = await fontResponse(new Request('shellspan-font://system/' + name), 'darwin', read);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'font fixture');
  }
  assert.deepEqual(paths, [
    '/System/Library/Fonts/SFNSMono.ttf',
    '/System/Library/Fonts/SFNSMonoItalic.ttf',
  ]);
  for (const url of [
    'shellspan-font://other/mono-regular',
    'shellspan-font://system/../../etc/passwd',
    'shellspan-font://system/mono-regular?file=/etc/passwd',
  ])
    assert.equal((await fontResponse(new Request(url), 'darwin', read)).status, 404);
  assert.equal(
    (
      await fontResponse(
        new Request('shellspan-font://system/mono-regular', { method: 'POST' }),
        'darwin',
        read,
      )
    ).status,
    404,
  );
  assert.equal(
    (await fontResponse(new Request('shellspan-font://system/mono-regular'), 'win32', read)).status,
    404,
  );
  assert.equal(paths.length, 2);
});
test('missing system font fails closed without substituting arbitrary files', async () => {
  assert.equal(
    (
      await fontResponse(
        new Request('shellspan-font://system/mono-regular'),
        'darwin',
        async () => {
          throw Error('absent');
        },
      )
    ).status,
    404,
  );
});
