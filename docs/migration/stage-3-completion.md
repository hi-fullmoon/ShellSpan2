# Stage 3 completion record

Date: 2026-09-09

Scope: database, data migration, and system credentials. SSH/SFTP, terminal/PTY, forwarding,
remote health, LLM execution, and Agent Runtime remain Rust-owned.

## Ownership decision

The complete `storage` and `credentials` domains now default to Node: 29 commands total. Together
with Stage 2, 44 commands across six domains are Node-owned by default. Whole-domain environment
overrides remain the rollback mechanism; because credentials own SQLite metadata, `storage` and
`credentials` must be switched together. There is no stateful command-level split, and a
Rust-routed rollback does not initialize the corresponding Node resources.

Rust is allowed to finish its existing startup data guard and LLM initialization before Node opens
the database. Electron first resolves any Node migration pending record, waits for Rust ready, and
then starts Node storage. This prevents legacy backup races. During the transition, Rust LLM owns
its route keys and Node owns desktop storage/credential keys; a single SQLite WAL serializes the
separate logical owners. No public operation is sent to both backends.

## Deliverables

| Requirement               | Evidence                                                                                                                                                                        | Status   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| SQLite owner              | `storage.ts` and `storage-worker.ts` isolate synchronous `node:sqlite` work from the Core event loop                                                                            | complete |
| Schema v1–v7              | `storage-schema.ts` reproduces the frozen tables, checks, indexes, secret purge, and v7 history cleanup                                                                         | complete |
| Safe migration            | Read-only version inspection, SQLite-consistent backups, sanitized pre-v2 backups, staging migration, integrity check, pending marker, atomic replacement, and startup recovery | complete |
| Offline recovery          | `storage-recovery.ts` and `pnpm storage:restore` require explicit absolute paths, verify source/staging integrity, and restore atomically                                       | complete |
| Desktop storage           | Profiles, Preferences, Recent Profiles, SFTP Bookmarks, Terminal Workspace, and SFTP Workspace preserve v1 command shapes and limits                                            | complete |
| LLM persistence primitive | The storage worker provides transactional route-document commit, one-time backup, and compare-and-swap revision conflict behavior for the later LLM migration                   | complete |
| System credentials        | `credential-store.ts` preserves macOS Keychain vault/legacy items, Windows Credential Manager target names, and Linux Secret Service attributes without using `safeStorage`     | complete |
| Credential commands       | Profile passwords/secrets and key credentials preserve metadata rollback, deletion, reference cleanup, type detection, and old service/account mappings                         | complete |
| Inline API keys           | Startup migrates `ai.providers[*].apiKey` to the system credential service, scrubs SQLite, and writes the idempotent v4 marker                                                  | complete |
| Public compatibility      | Schema v1, Renderer, and Preload sources remain unchanged                                                                                                                       | complete |

## Data-safety evidence

- Every historical schema version from v1 through v7 is built as a real SQLite fixture and opened
  through the production storage Worker. All reach v7 and retain Profile rows.
- A v1 fixture containing deprecated plaintext credential data produces a v2-compatible sanitized
  backup: the obsolete column and jump-host password are absent, and sentinel bytes do not occur
  in the backup.
- A schema version newer than 7 is rejected from a read-only inspection; the database SHA-256 is
  identical before and after the attempt.
- Injected failure after migration v4 leaves the original database byte-for-byte unchanged. A
  retry completes normally; a separately constructed pending replacement recovers on startup.
- Offline restore rejects relative paths and corrupt backups before changing the target. A verified
  backup replaces the target and passes a second integrity check.
- Credential sentinels are verified absent from the database, WAL, SHM, migration backup, errors,
  and diagnostics. Metadata transaction failure restores the previous system credential value.
- Inline provider keys are removed from SQLite and remain retrievable from the credential store;
  repeated startup is idempotent.

## Compatibility and platform evidence

- macOS keeps the existing version-1 single-item credential vault and lazily imports older
  service/account items with tombstones through the native Keychain API. An upgrade or rollback can
  require normal one-time Keychain authorization, but never secret re-entry.
- Windows uses the Rust keyring target mapping `{account}.{service}`, UTF-16 credential blobs, and
  enterprise persistence through Credential Manager APIs invoked without placing secrets in argv.
- Linux uses Secret Service's exact `service` and `username` attributes and sends secret bytes only
  over stdin.
- `node:sqlite` was selected over `better-sqlite3`: Electron/Node 24 already supplies the required
  WAL, timeout, backup, transaction, and integrity APIs, avoids an additional ABI-bound native
  module, and passed development and packaged execution.

## Verification record

- `pnpm test:desktop`: 60 tests passed.
- `pnpm test:core-stage3`: real Rust/Node responses and final SQLite state matched exactly.
- `pnpm test`: 1,319 tests passed and 1 test was skipped.
- `pnpm test:native`: 682 tests passed and 27 environment-gated tests were ignored.
- `pnpm contract:check`: 141 commands and 14 domains verified.
- `pnpm check:desktop`: executable preload, schemas, routing, fixtures, and event visibility verified.
- `pnpm build`: passed.
- `pnpm test:credential-platform`: a real macOS Keychain item round-tripped through the native API
  and was deleted after verification.
- `pnpm lint`, `pnpm format:check`, and `cargo fmt --check`: passed.
- `pnpm test:desktop:smoke`: native, Stage 1/2/3 differential, unchanged Renderer bridge,
  Node storage/credential calls, terminal, and SFTP navigation passed.
- `pnpm electron:pack` and `node scripts/electron-smoke.ts --packaged`: macOS arm64 unpacked
  package passed with the app.asar storage Worker, `node:sqlite`, six default Node domains,
  Rust terminal, and unchanged Renderer bridge. A second packaged-process probe round-tripped and
  deleted a real Keychain item through the rebuilt native binding. Local code signing was
  unavailable and intentionally skipped.
- `git diff --check`: passed.

## Exit decision

All Stage 3 exit conditions and final verification gates pass. Stage 4 work is intentionally absent.
