import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NodeCoreBackend } from '../node-core-backend.ts';
import { StorageClient } from '../node-core/storage.ts';
import { schemas } from '../node-core/storage-schema.ts';
import { windowsCredentialTarget } from '../node-core/credential-store.ts';
import { restoreDatabaseBackup, storageMigrationPaths } from '../node-core/storage-recovery.ts';

async function nodeBackend(root: string) {
  const backend = new NodeCoreBackend({
    ...process.env,
    SHELLSPAN_HOME: root,
    SHELLSPAN_APP_DATA: join(root, 'app'),
    SHELLSPAN_LOG_DIR: join(root, 'logs'),
    SHELLSPAN_NODE_CORE_TEST_MODE: '1',
    SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
    SHELLSPAN_NODE_DOMAINS: 'storage,credentials',
  });
  await backend.ready;
  return backend;
}

async function value(backend: NodeCoreBackend, command: string, args: object = {}) {
  const result = await backend.invoke(command, args);
  if (!result.ok) throw new Error(String(result.error));
  return result.value;
}

function createVersion(path: string, version: number, withLegacySecrets = false) {
  const db = new DatabaseSync(path);
  try {
    for (let index = 0; index < version; index++) db.exec(schemas[index]);
    if (withLegacySecrets) db.exec('ALTER TABLE key_credentials ADD COLUMN value TEXT');
    const organization = version >= 4 ? ',organization_json' : '';
    const organizationValue = version >= 4 ? ',NULL' : '';
    db.exec(`INSERT INTO profiles(id,name,host,port,username,auth_method,keychain_key_id,jump_host_config${organization},created_at,updated_at)
      VALUES('profile-${version}','Profile ${version}','host',22,'user','password',NULL,
      '${JSON.stringify({ host: 'jump', password: withLegacySecrets ? 'plaintext-password' : undefined }).replaceAll("'", "''")}'${organizationValue},1,2)`);
    if (withLegacySecrets)
      db.exec(`INSERT INTO key_credentials(id,label,updated_at,key_type,kind,public_key,certificate,service,value)
       VALUES('legacy-key','Legacy',1,'rsa','keyFile',NULL,NULL,'com.shellspan.key','plaintext-private-key')`);
  } finally {
    db.close();
  }
}

test(
  'storage CRUD, workspace bounds and CAS match the frozen domain',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-stage3-storage-'));
    const backend = await nodeBackend(root);
    try {
      const profile = {
        id: 'profile-1',
        name: 'Alpha',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authMethod: 'password',
        createdAt: 1,
        updatedAt: 2,
      };
      assert.equal(await value(backend, 'add_profile', { profile }), null);
      assert.deepEqual(await value(backend, 'list_profiles'), [
        {
          ...profile,
          keychainKeyId: null,
          jumpHostConfig: null,
          organizationJson: null,
        },
      ]);
      assert.equal(
        await value(backend, 'update_profile', {
          id: profile.id,
          profile: { ...profile, name: 'Beta', updatedAt: 3 },
        }),
        null,
      );
      await value(backend, 'touch_recent_profile', { profileId: profile.id });
      assert.deepEqual(await value(backend, 'list_recent_profiles'), [profile.id]);

      const bookmark = {
        id: 'bookmark-1',
        host: 'example.com',
        port: 22,
        username: 'alice',
        path: '/srv/世界',
        side: 'remote',
        createdAt: 4,
      };
      await value(backend, 'add_sftp_bookmark', { bookmark });
      assert.deepEqual(
        await value(backend, 'list_sftp_bookmarks', {
          host: bookmark.host,
          port: bookmark.port,
          username: bookmark.username,
        }),
        [{ ...bookmark, label: null }],
      );

      await value(backend, 'save_preferences', {
        entries: [
          ['theme', 'dark'],
          ['electron.webviewMigration.v1', 'private-migration'],
        ],
      });
      assert.ok(
        ((await value(backend, 'load_preferences')) as Array<[string, string]>).some(
          ([key, entry]) => key === 'theme' && entry === 'dark',
        ),
      );
      assert.ok(
        !((await value(backend, 'load_preferences')) as Array<[string, string]>).some(([key]) =>
          key.startsWith('electron.webviewMigration.'),
        ),
      );

      const terminal = JSON.stringify({ version: 1, sessions: [] });
      await value(backend, 'save_terminal_workspace', { sessionsJson: terminal });
      assert.equal(await value(backend, 'load_terminal_workspace'), terminal);
      const invalid = await backend.invoke('save_terminal_workspace', {
        sessionsJson: JSON.stringify({ version: 2, sessions: [] }),
      });
      assert.deepEqual(invalid, { ok: false, error: 'terminal workspace version is unsupported' });
      await value(backend, 'clear_terminal_workspace');
      assert.equal(await value(backend, 'load_terminal_workspace'), null);

      await value(backend, 'save_sftp_workspace', { workspaceJson: '{"tabs":[]}' });
      assert.equal(await value(backend, 'load_sftp_workspace'), '{"tabs":[]}');
      await value(backend, 'clear_sftp_workspace');
      assert.equal(await value(backend, 'load_sftp_workspace'), null);

      const bulkWrite = backend.invoke('save_preferences', {
        entries: Array.from({ length: 2000 }, (_, index) => [`bulk.${index}`, String(index)]),
      });
      const healthStarted = Date.now();
      assert.equal((await backend.invoke('get_system_health')).ok, true);
      assert.ok(Date.now() - healthStarted < 1000);
      assert.equal((await bulkWrite).ok, true);

      const document = JSON.stringify({ revision: 1, routes: [] });
      const [first, second] = await Promise.all([
        backend.invoke('__test_storage', {
          command: '__db_commit_llm_routes',
          args: { expected: null, document, backup: '[]' },
        }),
        backend.invoke('__test_storage', {
          command: '__db_commit_llm_routes',
          args: { expected: null, document, backup: '[]' },
        }),
      ]);
      assert.equal([first, second].filter((result) => result.ok).length, 1);
      assert.equal([first, second].filter((result) => !result.ok).length, 1);
    } finally {
      await backend.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'schema v1-v7 fixtures upgrade through isolated backups without losing rows',
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-stage3-schema-'));
    try {
      for (let version = 1; version <= 7; version++) {
        const directory = join(root, `v${version}`);
        await mkdir(directory);
        const path = join(directory, 'shellspan.db');
        createVersion(path, version, version === 1);
        const storage = new StorageClient(path);
        await storage.ready;
        assert.equal(await storage.invoke('__db_schema_version'), 7);
        const profiles = await storage.invoke<Array<{ id: string }>>('list_profiles');
        assert.equal(profiles[0].id, `profile-${version}`);
        await storage.stop();
        const backupPath = storageMigrationPaths(path, version).backup!;
        assert.equal(
          await stat(backupPath).then(
            () => true,
            () => false,
          ),
          version < 7,
        );
        if (version === 1) {
          const backup = new DatabaseSync(backupPath, { readOnly: true });
          const columns = backup.prepare('PRAGMA table_info(key_credentials)').all() as Array<{
            name: string;
          }>;
          assert.equal(
            columns.some((column) => column.name === 'value'),
            false,
          );
          const jump = backup
            .prepare("SELECT jump_host_config value FROM profiles WHERE id='profile-1'")
            .get() as { value: string };
          assert.equal(JSON.parse(jump.value).password, undefined);
          backup.close();
          assert.doesNotMatch(
            (await readFile(backupPath)).toString('latin1'),
            /plaintext-(?:password|private-key)/,
          );
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'newer schemas are rejected byte-for-byte and injected migration failure leaves the source intact',
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-stage3-failure-'));
    try {
      const newer = join(root, 'newer.db');
      createVersion(newer, 7);
      const newerDatabase = new DatabaseSync(newer);
      newerDatabase.exec('INSERT INTO schema_version(version) VALUES(8)');
      newerDatabase.close();
      const before = createHash('sha256')
        .update(await readFile(newer))
        .digest('hex');
      const unsupported = new StorageClient(newer);
      await assert.rejects(unsupported.ready, /newer than this build/);
      await unsupported.stop();
      assert.equal(
        createHash('sha256')
          .update(await readFile(newer))
          .digest('hex'),
        before,
      );

      const interrupted = join(root, 'interrupted.db');
      createVersion(interrupted, 1, true);
      const original = createHash('sha256')
        .update(await readFile(interrupted))
        .digest('hex');
      const failing = new StorageClient(interrupted, 4);
      await assert.rejects(failing.ready, /injected storage migration failure/);
      await failing.stop();
      assert.equal(
        createHash('sha256')
          .update(await readFile(interrupted))
          .digest('hex'),
        original,
      );
      assert.equal(
        await stat(storageMigrationPaths(interrupted).pending).then(
          () => true,
          () => false,
        ),
        false,
      );

      const retry = new StorageClient(interrupted);
      await retry.ready;
      assert.equal(await retry.invoke('__db_schema_version'), 7);
      await retry.stop();

      const recoverTarget = join(root, 'recover.db');
      const recovery = storageMigrationPaths(recoverTarget, 1);
      createVersion(recovery.staging, 7);
      createVersion(recovery.backup!, 1);
      await writeFile(
        recovery.pending,
        JSON.stringify({
          version: 1,
          databasePath: recoverTarget,
          staging: recovery.staging,
          backup: recovery.backup,
        }),
      );
      const recovered = new StorageClient(recoverTarget);
      await recovered.ready;
      assert.equal(await recovered.invoke('__db_schema_version'), 7);
      await recovered.stop();
      assert.equal(
        await stat(recovery.pending).then(
          () => true,
          () => false,
        ),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'credentials retain legacy namespaces, roll metadata together and never enter SQLite',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-stage3-credentials-'));
    const backend = await nodeBackend(root);
    const password = 'PASSWORD_SENTINEL_世界';
    const privateKey =
      '-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_KEY_SENTINEL\n-----END RSA PRIVATE KEY-----';
    try {
      const profile = {
        id: 'profile-secret',
        name: 'Secret profile',
        host: 'host',
        port: 22,
        username: 'user',
        authMethod: 'key',
        keychainKeyId: 'key-1',
        jumpHostConfig: JSON.stringify({ keychainKeyId: 'key-1' }),
        createdAt: 1,
        updatedAt: 1,
      };
      await value(backend, 'add_profile', { profile });
      await value(backend, 'store_profile_password', { profileId: profile.id, password });
      assert.equal(
        await value(backend, 'retrieve_profile_password', { profileId: profile.id }),
        password,
      );
      await value(backend, 'store_profile_secret', {
        profileId: profile.id,
        kind: 'jump-passphrase',
        value: 'JUMP_SECRET_SENTINEL',
      });
      assert.equal(
        await value(backend, 'retrieve_profile_secret', {
          profileId: profile.id,
          kind: 'jump-passphrase',
        }),
        'JUMP_SECRET_SENTINEL',
      );

      await value(backend, '__test_credential_seed', {
        service: 'com.shellspan.dev.profile-secret',
        account: `${profile.id}:passphrase`,
        value: 'LEGACY_SECRET_SENTINEL',
      });
      assert.equal(
        await value(backend, 'retrieve_profile_secret', {
          profileId: profile.id,
          kind: 'passphrase',
        }),
        'LEGACY_SECRET_SENTINEL',
      );
      assert.equal(
        await value(backend, '__test_credential_raw_get', {
          service: 'com.shellspan.dev.profile-secret',
          account: `${profile.id}:passphrase`,
        }),
        null,
      );

      await value(backend, 'store_key_credential', {
        request: {
          id: 'key-1',
          label: 'Server key',
          kind: 'keyfile',
          privateKey,
          publicKey: 'ssh-rsa PUBLIC',
          keyType: null,
        },
      });
      const key = (await value(backend, 'retrieve_key_credential', { id: 'key-1' })) as {
        keyType: string;
        privateKey: string;
      };
      assert.equal(key.keyType, 'rsa');
      assert.equal(key.privateKey, privateKey);
      assert.equal(((await value(backend, 'list_key_credentials')) as unknown[]).length, 2);
      assert.deepEqual(await value(backend, 'delete_key_credential', { id: 'key-1' }), [
        profile.id,
      ]);
      const updated = (
        (await value(backend, 'list_profiles')) as Array<{
          keychainKeyId: string | null;
          jumpHostConfig: string;
        }>
      )[0];
      assert.equal(updated.keychainKeyId, null);
      assert.equal(JSON.parse(updated.jumpHostConfig).keychainKeyId, undefined);
      await value(backend, '__test_storage', {
        command: '__db_test_drop_key_credentials',
      });
      const failedUpdate = await backend.invoke('store_profile_password', {
        profileId: profile.id,
        password: 'NEW_PASSWORD_SENTINEL',
      });
      assert.equal(failedUpdate.ok, false);
      assert.doesNotMatch(JSON.stringify(failedUpdate), /NEW_PASSWORD_SENTINEL/);
      assert.equal(
        await value(backend, 'retrieve_profile_password', { profileId: profile.id }),
        password,
      );
    } finally {
      await backend.stop();
    }
    const databasePath = join(root, '.shellspan-dev', 'shellspan.db');
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`])
      if (
        await stat(path).then(
          () => true,
          () => false,
        )
      )
        assert.doesNotMatch(
          (await readFile(path)).toString('latin1'),
          /(?:PASSWORD|PRIVATE_KEY|JUMP_SECRET|LEGACY_SECRET)_SENTINEL/,
        );
    await rm(root, { recursive: true, force: true });
  },
);

test(
  'inline provider keys migrate to the credential store and are scrubbed from SQLite',
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-stage3-inline-'));
    const data = join(root, '.shellspan-dev');
    await mkdir(data);
    const path = join(data, 'shellspan.db');
    createVersion(path, 7);
    const secret = 'INLINE_API_KEY_SENTINEL';
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO preferences(key,value) VALUES(?,?)').run(
      'ai.providers',
      JSON.stringify([{ id: 'provider-1', apiKey: secret, kind: 'openai' }]),
    );
    db.close();
    const backend = await nodeBackend(root);
    try {
      assert.equal(
        await value(backend, '__test_credential_get', {
          service: 'com.shellspan.dev.ai-provider',
          account: 'provider-1',
        }),
        secret,
      );
      const preferences = (await value(backend, 'load_preferences')) as Array<[string, string]>;
      assert.equal(preferences.find(([key]) => key === 'ai.apiKeyStorageMigrationV4')?.[1], 'true');
      assert.equal(
        JSON.parse(preferences.find(([key]) => key === 'ai.providers')![1])[0].apiKey,
        undefined,
      );
    } finally {
      await backend.stop();
    }
    for (const candidate of [path, `${path}-wal`, `${path}-shm`])
      if (
        await stat(candidate).then(
          () => true,
          () => false,
        )
      )
        assert.doesNotMatch(
          (await readFile(candidate)).toString('latin1'),
          /INLINE_API_KEY_SENTINEL/,
        );
    await rm(root, { recursive: true, force: true });
  },
);

test('Windows Credential Manager target names preserve the Rust keyring mapping', () => {
  assert.equal(
    windowsCredentialTarget('com.shellspan.profile-password', 'profile-1'),
    'profile-1.com.shellspan.profile-password',
  );
});

test('offline restore requires explicit paths, verifies the backup and rolls forward atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage3-restore-'));
  try {
    const target = join(root, 'target.db');
    const source = join(root, 'backup.db');
    createVersion(target, 7);
    createVersion(source, 7);
    const backup = new DatabaseSync(source);
    backup.exec("UPDATE profiles SET name='Restored' WHERE id='profile-7'");
    backup.close();
    await assert.rejects(restoreDatabaseBackup('relative.db', source), /absolute/);
    await restoreDatabaseBackup(target, source);
    const restored = new DatabaseSync(target, { readOnly: true });
    assert.equal(
      (restored.prepare("SELECT name FROM profiles WHERE id='profile-7'").get() as { name: string })
        .name,
      'Restored',
    );
    restored.close();

    const corrupt = join(root, 'corrupt.db');
    await writeFile(corrupt, 'not sqlite');
    const before = createHash('sha256')
      .update(await readFile(target))
      .digest('hex');
    await assert.rejects(restoreDatabaseBackup(target, corrupt));
    assert.equal(
      createHash('sha256')
        .update(await readFile(target))
        .digest('hex'),
      before,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
