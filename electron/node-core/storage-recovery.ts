import { DatabaseSync } from 'node:sqlite';
import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { CURRENT_SCHEMA_VERSION } from './storage-schema.ts';

function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export function storageMigrationPaths(databasePath: string, version?: number) {
  const directory = dirname(databasePath);
  const name = basename(databasePath).replaceAll(/[^A-Za-z0-9_.-]/g, '_');
  return {
    pending: join(directory, `.migration-node-${name}-restore-pending.json`),
    staging: join(directory, `.migration-node-${name}-${process.pid}.tmp`),
    backup:
      version === undefined
        ? undefined
        : join(directory, `.migration-node-${name}-schema-v${version}.backup`),
  };
}

export async function recoverInterruptedDatabase(databasePath: string) {
  const { pending } = storageMigrationPaths(databasePath);
  if (!(await exists(pending))) return;
  const value = JSON.parse(await readFile(pending, 'utf8')) as {
    version: number;
    databasePath: string;
    staging: string;
    backup: string;
  };
  const directory = dirname(databasePath);
  if (
    value.version !== 1 ||
    value.databasePath !== databasePath ||
    dirname(value.staging) !== directory ||
    !basename(value.staging).startsWith(`.migration-node-${basename(databasePath)}-`)
  )
    throw new Error('invalid database migration recovery record');
  if (!(await exists(databasePath))) {
    if (await exists(value.staging)) {
      verify(value.staging);
      await rename(value.staging, databasePath);
    } else if (await exists(value.backup)) {
      verify(value.backup);
      await copyFile(value.backup, databasePath);
    } else throw new Error('interrupted database migration has no recoverable copy');
  }
  await rm(value.staging, { force: true });
  await rm(pending, { force: true });
}

function verify(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string;
    };
    if (integrity.integrity_check !== 'ok')
      throw new Error('database backup integrity check failed');
    const version = Number(
      (
        database.prepare('SELECT COALESCE(MAX(version),0) version FROM schema_version').get() as {
          version: number;
        }
      ).version,
    );
    if (version > CURRENT_SCHEMA_VERSION)
      throw new Error(`database backup schema ${version} is unsupported`);
  } finally {
    database.close();
  }
}

/** Offline-only restore: both exact paths are mandatory and the source is verified first. */
export async function restoreDatabaseBackup(databasePath: string, backupPath: string) {
  if (!isAbsolute(databasePath) || !isAbsolute(backupPath))
    throw new Error('database and backup paths must be absolute');
  verify(backupPath);
  const migration = storageMigrationPaths(databasePath);
  const staging = migration.staging;
  const replaced = join(
    dirname(databasePath),
    `.migration-node-${basename(databasePath)}-restore-replaced`,
  );
  const pending = migration.pending;
  await rm(staging, { force: true });
  await rm(replaced, { force: true });
  await copyFile(backupPath, staging);
  verify(staging);
  await writeFile(
    pending,
    JSON.stringify({ version: 1, databasePath, staging, backup: backupPath }),
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  if (await exists(databasePath)) await rename(databasePath, replaced);
  try {
    await rename(staging, databasePath);
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(replaced, { force: true });
    await rm(pending, { force: true });
  } catch (error) {
    if (!(await exists(databasePath)) && (await exists(replaced)))
      await rename(replaced, databasePath);
    throw error;
  }
}
