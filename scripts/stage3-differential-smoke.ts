import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { RustCoreBackend } =
  require('../dist-electron/rust-core-backend.js') as typeof import('../electron/rust-core-backend.ts');
const { NodeCoreBackend } =
  require('../dist-electron/node-core-backend.js') as typeof import('../electron/node-core-backend.ts');

const executable = process.platform === 'win32' ? 'shellspan-core.exe' : 'shellspan-core';
const root = await mkdtemp(join(tmpdir(), 'shellspan-stage3-diff-'));
const rustRoot = join(root, 'rust');
const nodeRoot = join(root, 'node');
await Promise.all([mkdir(rustRoot), mkdir(nodeRoot)]);
const environment = (home: string) => ({
  ...process.env,
  SHELLSPAN_HOME: home,
  SHELLSPAN_APP_DATA: join(home, 'app'),
  SHELLSPAN_LOG_DIR: join(home, 'logs'),
  SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
  SHELLSPAN_NODE_DOMAINS: 'storage,credentials',
});
const rust = new RustCoreBackend(resolve('native/target/debug', executable), environment(rustRoot));
const node = new NodeCoreBackend(
  environment(nodeRoot),
  resolve('dist-electron/node-core/entry.js'),
);

async function both(command: string, rustArgs: object = {}, nodeArgs = rustArgs) {
  const result = await Promise.all([
    rust.invoke(command, rustArgs),
    node.invoke(command, nodeArgs),
  ]);
  assert.deepEqual(result[0], result[1], command);
  return result[0];
}

function databaseSnapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: db.prepare('SELECT MAX(version) value FROM schema_version').get(),
      profiles: db.prepare('SELECT * FROM profiles ORDER BY id').all(),
      recent: db.prepare('SELECT * FROM recent_profiles ORDER BY sort_order').all(),
      bookmarks: db.prepare('SELECT * FROM sftp_bookmarks ORDER BY id').all(),
      terminal: db.prepare('SELECT id,sessions_json FROM terminal_workspace').all(),
      sftp: db.prepare('SELECT id,workspace_json FROM sftp_workspace').all(),
      preferences: db
        .prepare("SELECT key,value FROM preferences WHERE key LIKE 'stage3.%' ORDER BY key")
        .all(),
    };
  } finally {
    db.close();
  }
}

try {
  await Promise.all([rust.ready, node.ready]);
  const profile = {
    id: 'profile-1',
    name: 'Profile 世界',
    host: 'example.com',
    port: 22,
    username: 'alice',
    authMethod: 'password',
    createdAt: 100,
    updatedAt: 200,
  };
  await both('add_profile', { profile });
  await both('list_profiles');
  await both('touch_recent_profile', { profileId: profile.id });
  await both('list_recent_profiles');
  const bookmark = {
    id: 'bookmark-1',
    host: profile.host,
    port: profile.port,
    username: profile.username,
    path: '/srv/世界',
    side: 'remote',
    createdAt: 300,
  };
  await both('add_sftp_bookmark', { bookmark });
  await both('list_sftp_bookmarks', {
    host: profile.host,
    port: profile.port,
    username: profile.username,
  });
  await both('save_preferences', {
    entries: [
      ['stage3.alpha', 'one'],
      ['stage3.beta', '二'],
    ],
  });
  const terminal = JSON.stringify({ version: 1, sessions: [] });
  await both('save_terminal_workspace', { sessionsJson: terminal });
  await both('load_terminal_workspace');
  await both('save_sftp_workspace', { workspaceJson: '{"tabs":[]}' });
  await both('load_sftp_workspace');
  assert.deepEqual(await both('list_key_credentials'), { ok: true, value: [] });
} finally {
  await Promise.all([rust.stop(), node.stop()]);
}

const suffix = process.env.SHELLSPAN_BUILD_MODE === 'production' ? '.shellspan' : '.shellspan-dev';
assert.deepEqual(
  databaseSnapshot(join(rustRoot, suffix, 'shellspan.db')),
  databaseSnapshot(join(nodeRoot, suffix, 'shellspan.db')),
);
await rm(root, { recursive: true, force: true });
console.log('Stage 3 Rust/Node storage responses and SQLite state matched exactly.');
