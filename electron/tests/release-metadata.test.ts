import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const {
  metadata,
}: {
  metadata: (
    tag: string,
    version: string,
    notes: string,
    changelog: string,
  ) => { notes: string; prerelease: boolean };
} = require(require('node:path').resolve('scripts/release-metadata.cjs'));

test('release tags preserve strict prerelease and manual notes behavior', () => {
  assert.deepEqual(metadata('v2.0.56', '2.0.56', '', '## [v2.0.56]\nBase notes\n'), {
    tag: 'v2.0.56',
    version: '2.0.56',
    prerelease: false,
    notes: 'Base notes',
  });
  assert.equal(metadata('v2.0.56-test.1', '2.0.56', 'Override', '').notes, 'Override');
  assert.equal(metadata('v2.0.56-beta', '2.0.56-beta', '', '').prerelease, true);
  for (const tag of ['v2.0.57', 'v2.0.56-test.01', 'v2.0.56-', 'v2.0.56-a\ninvalid', '$(echo bad)'])
    assert.throws(() => metadata(tag, '2.0.56', '', ''));
});
