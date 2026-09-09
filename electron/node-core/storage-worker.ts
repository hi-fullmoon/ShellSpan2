import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CURRENT_SCHEMA_VERSION, schemas } from './storage-schema.ts';
import { recoverInterruptedDatabase, storageMigrationPaths } from './storage-recovery.ts';

if (!parentPort) throw new Error('Storage worker requires a parent port');
const port = parentPort;
const storageOptions = workerData as { databasePath: string; testFailAfterVersion?: number };
const databasePath = storageOptions.databasePath;
let database: DatabaseSync;

function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function schemaVersion(db: DatabaseSync) {
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get() as { present?: number } | undefined;
  if (!table) return 0;
  return Number(
    (
      db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_version').get() as {
        version: number;
      }
    ).version,
  );
}

function migrate(db: DatabaseSync, current: number, target = CURRENT_SCHEMA_VERSION) {
  for (let version = current + 1; version <= target; version++) {
    db.exec(schemas[version - 1]);
    if (storageOptions.testFailAfterVersion === version)
      throw new Error(`injected storage migration failure after v${version}`);
  }
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  if (integrity.integrity_check !== 'ok') throw new Error('database integrity check failed');
}

async function prepareDatabase() {
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dirname(databasePath), 0o700);
  await recoverInterruptedDatabase(databasePath);
  if (!(await exists(databasePath))) {
    const fresh = new DatabaseSync(databasePath, { timeout: 5000 });
    try {
      migrate(fresh, 0);
    } finally {
      fresh.close();
    }
  } else {
    const source = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
    const current = schemaVersion(source);
    if (current > CURRENT_SCHEMA_VERSION) {
      source.close();
      throw new Error(
        `database schema version ${current} is newer than this build (${CURRENT_SCHEMA_VERSION})`,
      );
    }
    if (current < CURRENT_SCHEMA_VERSION) {
      const migration = storageMigrationPaths(databasePath, current);
      const staging = migration.staging;
      const backupPath = migration.backup!;
      await rm(staging, { force: true });
      if (!(await exists(backupPath))) {
        await backup(source, backupPath);
        if (current < 2) {
          const safeBackup = new DatabaseSync(backupPath, { timeout: 5000 });
          try {
            migrate(safeBackup, current, 2);
          } catch (error) {
            safeBackup.close();
            await rm(backupPath, { force: true });
            throw error;
          } finally {
            try {
              safeBackup.close();
            } catch {}
          }
        }
        if (process.platform !== 'win32') await chmod(backupPath, 0o600);
      }
      await backup(source, staging);
      source.close();
      const staged = new DatabaseSync(staging, { timeout: 5000 });
      try {
        migrate(staged, current);
      } catch (error) {
        staged.close();
        await rm(staging, { force: true });
        throw error;
      } finally {
        try {
          staged.close();
        } catch {}
      }
      const pending = migration.pending;
      await writeFile(
        pending,
        JSON.stringify({ version: 1, databasePath, staging, backup: backupPath }),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
      try {
        await rm(databasePath, { force: true });
        await rename(staging, databasePath);
      } catch (error) {
        if (!(await exists(databasePath))) await copyFile(backupPath, databasePath);
        throw error;
      }
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
      await rm(pending, { force: true });
    } else source.close();
  }
  if (process.platform !== 'win32') await chmod(databasePath, 0o600);
  database = new DatabaseSync(databasePath, { timeout: 5000 });
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
}

function rows(statement: string, ...values: unknown[]) {
  return database.prepare(statement).all(...(values as never[])) as Record<string, unknown>[];
}

function one(statement: string, ...values: unknown[]) {
  return database.prepare(statement).get(...(values as never[])) as
    | Record<string, unknown>
    | undefined;
}

function run(statement: string, ...values: unknown[]) {
  return database.prepare(statement).run(...(values as never[]));
}

function profile(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authMethod: row.auth_method,
    keychainKeyId: row.keychain_key_id,
    jumpHostConfig: row.jump_host_config,
    organizationJson: row.organization_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function bookmark(row: Record<string, unknown>) {
  return {
    id: row.id,
    host: row.host,
    port: row.port,
    username: row.username,
    path: row.path,
    side: row.side,
    label: row.label,
    createdAt: row.created_at,
  };
}

function validateTerminalWorkspace(raw: string) {
  if (Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error('terminal workspace exceeds the storage limit');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('terminal workspace must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('terminal workspace must be an object');
  const record = value as { version?: unknown; sessions?: unknown };
  if (record.version !== undefined && record.version !== 1)
    throw new Error('terminal workspace version is unsupported');
  if (!Array.isArray(record.sessions))
    throw new Error('terminal workspace sessions must be an array');
  if (record.sessions.length > 100) throw new Error('terminal workspace has too many sessions');
}

function command(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'list_profiles':
      return rows('SELECT * FROM profiles ORDER BY name').map(profile);
    case 'add_profile': {
      const p = args.profile as Record<string, unknown>;
      run(
        `INSERT INTO profiles(id,name,host,port,username,auth_method,keychain_key_id,jump_host_config,organization_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        p.id,
        p.name,
        p.host,
        p.port,
        p.username,
        p.authMethod,
        p.keychainKeyId ?? null,
        p.jumpHostConfig ?? null,
        p.organizationJson ?? null,
        p.createdAt,
        p.updatedAt,
      );
      return null;
    }
    case 'update_profile': {
      const p = args.profile as Record<string, unknown>;
      const result = run(
        `UPDATE profiles SET name=?,host=?,port=?,username=?,auth_method=?,keychain_key_id=?,jump_host_config=?,organization_json=?,created_at=?,updated_at=? WHERE id=?`,
        p.name,
        p.host,
        p.port,
        p.username,
        p.authMethod,
        p.keychainKeyId ?? null,
        p.jumpHostConfig ?? null,
        p.organizationJson ?? null,
        p.createdAt,
        p.updatedAt,
        args.id,
      );
      if (result.changes === 0n || result.changes === 0)
        throw new Error(`profile ${args.id} not found`);
      return null;
    }
    case 'remove_profile':
      run('DELETE FROM profiles WHERE id=?', args.id);
      return null;
    case 'load_preferences':
      return rows(
        "SELECT key,value FROM preferences WHERE key NOT GLOB 'electron.webviewMigration.*'",
      ).map((r) => [r.key, r.value]);
    case 'save_preferences':
      for (const [key, value] of args.entries as Array<[string, string]>)
        run(
          'INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          key,
          value,
        );
      return null;
    case 'list_recent_profiles':
      return rows('SELECT profile_id FROM recent_profiles ORDER BY sort_order ASC').map(
        (r) => r.profile_id,
      );
    case 'touch_recent_profile':
      database.exec('BEGIN IMMEDIATE');
      try {
        run('UPDATE recent_profiles SET sort_order=sort_order+1');
        run(
          'INSERT INTO recent_profiles(profile_id,sort_order) VALUES(?,0) ON CONFLICT(profile_id) DO UPDATE SET sort_order=0',
          args.profileId,
        );
        run('DELETE FROM recent_profiles WHERE sort_order>=10');
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return null;
    case 'remove_recent_profile':
      run('DELETE FROM recent_profiles WHERE profile_id=?', args.profileId);
      return null;
    case 'list_sftp_bookmarks':
      return rows(
        'SELECT * FROM sftp_bookmarks WHERE host=? AND port=? AND username=? ORDER BY created_at ASC',
        args.host,
        args.port,
        args.username,
      ).map(bookmark);
    case 'add_sftp_bookmark': {
      const b = args.bookmark as Record<string, unknown>;
      run(
        'INSERT INTO sftp_bookmarks(id,host,port,username,path,side,label,created_at) VALUES(?,?,?,?,?,?,?,?)',
        b.id,
        b.host,
        b.port,
        b.username,
        b.path,
        b.side,
        b.label ?? null,
        b.createdAt,
      );
      return null;
    }
    case 'remove_sftp_bookmark':
      run('DELETE FROM sftp_bookmarks WHERE id=?', args.id);
      return null;
    case 'load_terminal_workspace':
      return one('SELECT sessions_json FROM terminal_workspace WHERE id=1')?.sessions_json ?? null;
    case 'save_terminal_workspace':
      validateTerminalWorkspace(args.sessionsJson as string);
      run(
        'INSERT INTO terminal_workspace(id,sessions_json,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET sessions_json=excluded.sessions_json,updated_at=excluded.updated_at',
        args.sessionsJson,
        Date.now(),
      );
      return null;
    case 'clear_terminal_workspace':
      run('DELETE FROM terminal_workspace WHERE id=1');
      return null;
    case 'load_sftp_workspace':
      return one('SELECT workspace_json FROM sftp_workspace WHERE id=1')?.workspace_json ?? null;
    case 'save_sftp_workspace':
      run(
        'INSERT INTO sftp_workspace(id,workspace_json,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET workspace_json=excluded.workspace_json,updated_at=excluded.updated_at',
        args.workspaceJson,
        Date.now(),
      );
      return null;
    case 'clear_sftp_workspace':
      run('DELETE FROM sftp_workspace WHERE id=1');
      return null;
    case '__db_get_profile': {
      const row = one('SELECT * FROM profiles WHERE id=?', args.id);
      return row ? profile(row) : null;
    }
    case '__db_list_key_credentials':
      return rows(
        "SELECT id,label,COALESCE(key_type,'unknown') key_type,kind,service FROM key_credentials ORDER BY label",
      ).map((r) => ({
        id: r.id,
        label: r.label,
        keyType: r.key_type,
        kind: r.kind === 'password' ? 'password' : 'keyfile',
        service: r.service,
      }));
    case '__db_upsert_key_credential':
      run(
        `INSERT INTO key_credentials(id,label,key_type,kind,service,public_key,certificate,updated_at) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label,key_type=excluded.key_type,kind=excluded.kind,service=excluded.service,public_key=excluded.public_key,certificate=excluded.certificate,updated_at=excluded.updated_at`,
        args.id,
        args.label,
        args.keyType,
        args.kind,
        args.service,
        args.publicKey ?? null,
        args.certificate ?? null,
        args.updatedAt,
      );
      return null;
    case '__db_key_service':
      return one('SELECT service FROM key_credentials WHERE id=?', args.id)?.service ?? null;
    case '__db_delete_key_metadata':
      run('DELETE FROM key_credentials WHERE id=? AND service=?', args.id, args.service);
      return null;
    case '__db_delete_key':
      run('DELETE FROM key_credentials WHERE id=?', args.id);
      return null;
    case '__db_delete_key_references': {
      const referenced: string[] = [];
      const profiles = rows('SELECT id,keychain_key_id,jump_host_config FROM profiles');
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const p of profiles) {
          let changed = p.keychain_key_id === args.id;
          let jump = null;
          if (typeof p.jump_host_config === 'string') {
            try {
              jump = JSON.parse(p.jump_host_config);
            } catch {}
          }
          if (jump?.keychainKeyId === args.id) {
            delete jump.keychainKeyId;
            changed = true;
          }
          if (changed) {
            referenced.push(p.id as string);
            run(
              'UPDATE profiles SET keychain_key_id=CASE WHEN keychain_key_id=? THEN NULL ELSE keychain_key_id END,jump_host_config=?,updated_at=? WHERE id=?',
              args.id,
              jump ? JSON.stringify(jump) : p.jump_host_config,
              Date.now(),
              p.id,
            );
          }
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return referenced;
    }
    case '__db_commit_llm_routes': {
      database.exec('BEGIN IMMEDIATE');
      try {
        const raw = one("SELECT value FROM preferences WHERE key='llm.routes.v1'")?.value;
        const revision =
          typeof raw === 'string'
            ? ((JSON.parse(raw) as { revision?: number }).revision ?? null)
            : null;
        if (revision !== (args.expected ?? null)) throw new Error('REVISION_CONFLICT');
        if (typeof args.backup === 'string')
          run(
            "INSERT OR IGNORE INTO preferences(key,value) VALUES('llm.legacyBackup.v1',?)",
            args.backup,
          );
        run(
          "INSERT INTO preferences(key,value) VALUES('llm.routes.v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          args.document,
        );
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return null;
    }
    case '__db_schema_version':
      return schemaVersion(database);
    case '__db_test_drop_key_credentials':
      database.exec('DROP TABLE key_credentials');
      return null;
    default:
      throw new Error(`Unknown storage command: ${name}`);
  }
}

void (async () => {
  await prepareDatabase();
  port.postMessage({ type: 'ready' });
  port.on('message', (message: { id: number; command: string; args: Record<string, unknown> }) => {
    try {
      if (message.command === '__close') {
        database.close();
        port.postMessage({ id: message.id, ok: true, value: null });
        port.close();
        return;
      }
      port.postMessage({ id: message.id, ok: true, value: command(message.command, message.args) });
    } catch (error) {
      port.postMessage({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
})().catch((error) => {
  port.postMessage({
    type: 'failure',
    error: error instanceof Error ? error.message : String(error),
  });
});
