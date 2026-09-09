import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as assert from 'node:assert/strict';
import Ajv from 'ajv';
import valuesSchema from '../electron/contracts/v1/command-values.schema.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const { RustCoreBackend } =
  require('../dist-electron/rust-core-backend.js') as typeof import('../electron/rust-core-backend.ts');
const { NodeCoreBackend } =
  require('../dist-electron/node-core-backend.js') as typeof import('../electron/node-core-backend.ts');

const executable = process.platform === 'win32' ? 'shellspan-core.exe' : 'shellspan-core';
const binary = resolve('native/target/debug', executable);
const nodeEntry = resolve('dist-electron/node-core/entry.js');
const root = await mkdtemp(join(tmpdir(), 'shellspan-stage2-diff-'));
const rustRoot = join(root, 'rust');
const nodeRoot = join(root, 'node');
await Promise.all([mkdir(rustRoot), mkdir(nodeRoot)]);

function environment(base: string) {
  return {
    ...process.env,
    SHELLSPAN_HOME: join(base, 'home'),
    SHELLSPAN_APP_DATA: join(base, 'data'),
    SHELLSPAN_LOG_DIR: join(base, 'logs'),
    SHELLSPAN_APP_VERSION: '2.0.56',
    SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
  };
}
await Promise.all(
  [rustRoot, nodeRoot].flatMap((base) => [
    mkdir(join(base, 'home')),
    mkdir(join(base, 'data')),
    mkdir(join(base, 'logs')),
  ]),
);
const rust = new RustCoreBackend(binary, environment(rustRoot));
const node = new NodeCoreBackend(environment(nodeRoot), nodeEntry);

async function invoke(
  backend: InstanceType<typeof RustCoreBackend> | InstanceType<typeof NodeCoreBackend>,
  command: string,
  args: object = {},
) {
  return backend.invoke(command, args);
}

function normalize(value: unknown, bases: string[]): unknown {
  if (typeof value === 'string')
    return bases.reduce((result, base) => result.replaceAll(base, '<root>'), value);
  if (Array.isArray(value)) return value.map((item) => normalize(item, bases));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalize(item, bases)]),
    );
  return value;
}

async function seed(base: string) {
  const source = join(base, 'fixture');
  await mkdir(join(source, 'nested'), { recursive: true });
  await writeFile(join(source, 'alpha.txt'), 'alpha 世界\n');
  await writeFile(join(source, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(source, 'invalid.doc'), Buffer.from([0, 1, 2]));
  await writeFile(join(source, 'nested', 'child.txt'), 'child');
  const timestamp = new Date('2024-01-02T03:04:05Z');
  for (const path of [
    join(source, 'alpha.txt'),
    join(source, 'binary.bin'),
    join(source, 'invalid.doc'),
    join(source, 'nested'),
  ])
    await utimes(path, timestamp, timestamp);
  await writeFile(join(base, 'logs', 'frontend.fixture.log'), 'same log\n');
  await utimes(join(base, 'logs', 'frontend.fixture.log'), timestamp, timestamp);
  return source;
}

async function snapshot(base: string, directory: string) {
  const result: Array<[string, string, string?]> = [];
  async function walk(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const metadata = await stat(child);
      const key = relative(base, child).replaceAll('\\', '/');
      if (metadata.isDirectory()) {
        result.push([key, 'directory']);
        await walk(child);
      } else result.push([key, 'file', await readFile(child, 'utf8')]);
    }
  }
  await walk(directory);
  return result;
}

try {
  await Promise.all([rust.ready, node.ready]);
  const [rustSource, nodeSource] = await Promise.all([seed(rustRoot), seed(nodeRoot)]);
  const rustCanonical = await realpath(rustRoot);
  const nodeCanonical = await realpath(nodeRoot);
  const rustBases = [rustRoot, rustCanonical];
  const nodeBases = [nodeRoot, nodeCanonical];

  const [rustListing, nodeListing] = await Promise.all([
    invoke(rust, 'list_local_directory', { path: rustSource }),
    invoke(node, 'list_local_directory', { path: nodeSource }),
  ]);
  assert.deepEqual(normalize(rustListing, rustBases), normalize(nodeListing, nodeBases));

  for (const name of ['alpha.txt', 'binary.bin', 'invalid.doc']) {
    const [rustPreview, nodePreview] = await Promise.all([
      invoke(rust, 'preview_local_file', { path: join(rustSource, name) }),
      invoke(node, 'preview_local_file', { path: join(nodeSource, name) }),
    ]);
    assert.deepEqual(normalize(rustPreview, rustBases), normalize(nodePreview, nodeBases));
  }

  const [rustRead, nodeRead] = await Promise.all([
    invoke(rust, 'read_text_file', { path: join(rustSource, 'alpha.txt') }),
    invoke(node, 'read_text_file', { path: join(nodeSource, 'alpha.txt') }),
  ]);
  assert.deepEqual(rustRead, nodeRead);

  const copyRequest = (source: string, destination: string, operationId: string) => ({
    request: {
      sourcePaths: [source],
      destinationDirectory: destination,
      conflictPolicies: [],
      operationId,
    },
  });
  const rustDestination = join(rustRoot, 'copied');
  const nodeDestination = join(nodeRoot, 'copied');
  const [rustCopy, nodeCopy] = await Promise.all([
    invoke(rust, 'copy_local_paths', copyRequest(rustSource, rustDestination, 'rust-copy')),
    invoke(node, 'copy_local_paths', copyRequest(nodeSource, nodeDestination, 'node-copy')),
  ]);
  assert.deepEqual(rustCopy, nodeCopy);
  assert.deepEqual(
    await snapshot(rustRoot, rustDestination),
    (await snapshot(nodeRoot, nodeDestination)).map(([path, ...rest]) => [path, ...rest]),
  );

  const [rustConflict, nodeConflict] = await Promise.all([
    invoke(rust, 'copy_local_paths', copyRequest(rustSource, rustDestination, 'rust-conflict')),
    invoke(node, 'copy_local_paths', copyRequest(nodeSource, nodeDestination, 'node-conflict')),
  ]);
  assert.deepEqual(rustConflict, nodeConflict);

  const [rustPaste, nodePaste] = await Promise.all([
    invoke(rust, 'paste_local_paths', {
      sourcePaths: [join(rustSource, 'alpha.txt')],
      destinationDirectory: rustSource,
      copySuffix: 'copy',
    }),
    invoke(node, 'paste_local_paths', {
      sourcePaths: [join(nodeSource, 'alpha.txt')],
      destinationDirectory: nodeSource,
      copySuffix: 'copy',
    }),
  ]);
  assert.deepEqual(normalize(rustPaste, rustBases), normalize(nodePaste, nodeBases));

  const [rustLog, nodeLog] = await Promise.all([
    invoke(rust, 'read_log_file', { name: 'frontend.fixture.log' }),
    invoke(node, 'read_log_file', { name: 'frontend.fixture.log' }),
  ]);
  assert.deepEqual(rustLog, nodeLog);

  for (const command of ['petdex_get_status', 'petdex_test_connection'])
    assert.deepEqual(await invoke(rust, command), await invoke(node, command));
  assert.deepEqual(
    await invoke(rust, 'petdex_set_enabled', { enabled: false }),
    await invoke(node, 'petdex_set_enabled', { enabled: false }),
  );

  const definitions = valuesSchema.definitions;
  const healthValidator = new Ajv({ strict: false }).compile({
    ...definitions.CommandValues.properties.get_system_health,
    definitions,
  });
  const [rustHealth, nodeHealth] = await Promise.all([
    invoke(rust, 'get_system_health'),
    invoke(node, 'get_system_health'),
  ]);
  assert.equal(rustHealth.ok, true);
  assert.equal(nodeHealth.ok, true);
  if (rustHealth.ok && nodeHealth.ok) {
    assert.equal(healthValidator(rustHealth.value), true);
    assert.equal(healthValidator(nodeHealth.value), true);
    assert.deepEqual(
      (rustHealth.value as { appInfo: unknown }).appInfo,
      (nodeHealth.value as { appInfo: unknown }).appInfo,
    );
  }
  console.log(
    'Stage 2 Rust/Node read, conflict, write-state, log, health and Petdex differential passed.',
  );
} finally {
  await Promise.all([rust.stop(), node.stop()]);
  await rm(root, { recursive: true, force: true });
}
