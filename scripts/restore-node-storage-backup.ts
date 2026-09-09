import { restoreDatabaseBackup } from '../electron/node-core/storage-recovery.ts';

const databaseIndex = process.argv.indexOf('--database');
const backupIndex = process.argv.indexOf('--backup');
const database = databaseIndex >= 0 ? process.argv[databaseIndex + 1] : undefined;
const backup = backupIndex >= 0 ? process.argv[backupIndex + 1] : undefined;
if (!database || !backup)
  throw new Error(
    'Usage: pnpm storage:restore --database <absolute-path> --backup <absolute-path>',
  );
await restoreDatabaseBackup(database, backup);
console.log('Database backup restored and verified.');
