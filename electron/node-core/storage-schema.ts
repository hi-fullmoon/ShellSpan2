export const CURRENT_SCHEMA_VERSION = 7;

export const schemas = [
  `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS profiles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22,
 username TEXT NOT NULL, auth_method TEXT NOT NULL CHECK(auth_method IN ('password','key')),
 keychain_key_id TEXT, jump_host_config TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recent_profiles (
 profile_id TEXT NOT NULL, sort_order INTEGER NOT NULL, PRIMARY KEY(profile_id),
 FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sftp_bookmarks (
 id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL,
 path TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('local','remote')), label TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS terminal_workspace (
 id INTEGER PRIMARY KEY CHECK(id=1), sessions_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS key_credentials (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, updated_at INTEGER NOT NULL, key_type TEXT DEFAULT 'unknown',
 kind TEXT NOT NULL DEFAULT 'keyFile', public_key TEXT, certificate TEXT,
 service TEXT NOT NULL DEFAULT 'com.shellspan.key'
);
INSERT INTO schema_version(version) VALUES(1);`,
  `
PRAGMA secure_delete=ON;
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS key_credentials_v2;
CREATE TABLE key_credentials_v2 (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, updated_at INTEGER NOT NULL, key_type TEXT DEFAULT 'unknown',
 kind TEXT NOT NULL DEFAULT 'keyFile', public_key TEXT, certificate TEXT,
 service TEXT NOT NULL DEFAULT 'com.shellspan.key'
);
INSERT INTO key_credentials_v2(id,label,updated_at,key_type,kind,public_key,certificate,service)
 SELECT id,label,updated_at,key_type,kind,public_key,certificate,service FROM key_credentials;
DROP TABLE key_credentials;
ALTER TABLE key_credentials_v2 RENAME TO key_credentials;
UPDATE profiles SET jump_host_config=CASE WHEN json_valid(jump_host_config)
 THEN json_remove(jump_host_config,'$.password','$.passphrase','$.privateKeyData') ELSE NULL END
 WHERE jump_host_config IS NOT NULL;
INSERT INTO schema_version(version) VALUES(2);
COMMIT;
PRAGMA wal_checkpoint(TRUNCATE);
VACUUM;`,
  `BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS sftp_workspace (
 id INTEGER PRIMARY KEY CHECK(id=1), workspace_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO schema_version(version) VALUES(3); COMMIT;`,
  `BEGIN IMMEDIATE; ALTER TABLE profiles ADD COLUMN organization_json TEXT;
INSERT INTO schema_version(version) VALUES(4); COMMIT;`,
  `BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS operation_history_events (
 event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 parent_operation_id TEXT, occurred_at INTEGER NOT NULL, category TEXT NOT NULL, action TEXT NOT NULL,
 event_kind TEXT NOT NULL, status TEXT NOT NULL, risk TEXT, subject_id TEXT, primary_profile_id TEXT,
 targets_json TEXT NOT NULL, command_preview TEXT, evidence_json TEXT NOT NULL, error_category TEXT,
 retry_of_operation_id TEXT, item_count INTEGER, byte_count INTEGER, exit_code INTEGER,
 batch_index INTEGER, batch_total INTEGER, concurrency_limit INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operation_history_task_time ON operation_history_events(task_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_operation_history_time ON operation_history_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_history_category_status ON operation_history_events(category,status,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_history_profile_time ON operation_history_events(primary_profile_id,occurred_at DESC);
INSERT INTO schema_version(version) VALUES(5); COMMIT;`,
  `BEGIN IMMEDIATE;
ALTER TABLE operation_history_events ADD COLUMN permission_mode TEXT
 CHECK(permission_mode IS NULL OR permission_mode IN ('requestApproval','autoApproveReadOnly','fullAccess'));
ALTER TABLE operation_history_events ADD COLUMN human_approved INTEGER
 CHECK(human_approved IS NULL OR human_approved IN (0,1));
CREATE INDEX IF NOT EXISTS idx_operation_history_action_task ON operation_history_events(action,task_id,occurred_at);
INSERT INTO schema_version(version) VALUES(6); COMMIT;`,
  `BEGIN IMMEDIATE; DROP TABLE IF EXISTS operation_history_events;
DELETE FROM preferences WHERE key='operationHistoryRetentionDays';
INSERT INTO schema_version(version) VALUES(7); COMMIT;`,
] as const;
