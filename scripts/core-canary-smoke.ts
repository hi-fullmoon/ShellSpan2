import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import * as assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { RustCoreBackend } =
  require('../dist-electron/rust-core-backend.js') as typeof import('../electron/rust-core-backend.ts');
const { NodeCoreBackend } =
  require('../dist-electron/node-core-backend.js') as typeof import('../electron/node-core-backend.ts');
const { CoreBackendRouter } =
  require('../dist-electron/core-router.js') as typeof import('../electron/core-router.ts');

const executable = process.platform === 'win32' ? 'shellspan-core.exe' : 'shellspan-core';
const binary = resolve('native/target/debug', executable);
const nodeEntry = resolve('dist-electron/node-core/entry.js');
const root = await mkdtemp(join(tmpdir(), 'shellspan-canary-'));
const fixture = join(root, 'read-text-canary.txt');
const invalidFixture = join(root, 'read-text-invalid.bin');
const missingFixture = join(root, 'read-text-missing.txt');
await writeFile(fixture, 'ShellSpan Rust/Node canary\nUnicode: 世界 🐚\n');
await writeFile(invalidFixture, Buffer.from([0xff, 0xfe, 0xfd]));
const env = {
  ...process.env,
  SHELLSPAN_HOME: root,
  SHELLSPAN_APP_DATA: join(root, 'data'),
  SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
};
const router = new CoreBackendRouter(
  new RustCoreBackend(binary, env),
  new NodeCoreBackend(env, nodeEntry),
  new Map(),
  'compare',
);

try {
  await router.ready;
  const result = await router.invoke('read_text_file', { path: fixture });
  assert.deepEqual(result, {
    ok: true,
    value: 'ShellSpan Rust/Node canary\nUnicode: 世界 🐚\n',
  });
  const invalid = await router.invoke('read_text_file', { path: invalidFixture });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(String(invalid.error), /stream did not contain valid UTF-8/);
  const missing = await router.invoke('read_text_file', { path: missingFixture });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(String(missing.error), /os error 2/);
  console.log('Rust/Node read_text_file canary matched exactly.');
} finally {
  await router.stop();
  await rm(root, { recursive: true, force: true });
}
