# Stage 2 completion record

Date: 2026-09-09

Scope: infrastructure and low-risk local capabilities. Database, workspace persistence, system
credentials, SSH/SFTP sessions, PTY, forwarding, LLM, and Agent resources remain Rust-owned.

## Ownership decision

The frozen `health`, `local-fs`, `logs`, and `petdex` domains now default to Node as complete
units: 15 commands total. `export_log_file` remains an Electron-owned save dialog, while its
schema validation follows the `logs` backend. `SHELLSPAN_CORE_BACKENDS` can roll back any whole
domain to Rust. No Stage 3 resource is opened or written by Node.

## Deliverables

| Requirement                   | Evidence                                                                                                                                                                                    | Status   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| App state and paths           | `node-core/state.ts`, `paths.ts`, and `cancellation.ts` own process lifecycle, app/home/log directories, active request cancellation, and local operation identity                          | complete |
| Event and diagnostic boundary | `events.ts`, `redaction.ts`, and the Rust-to-Node Petdex activity bridge keep protocol-v1 events ordered and redact diagnostic secrets                                                      | complete |
| Local health                  | `health.ts` asynchronously samples process/system CPU, memory, swap, disk, process size/thread count, version, platform, and architecture                                                   | complete |
| Local filesystem              | `local-fs.ts` implements directory listing, copy conflict policies, paste naming, rename, open, preview (including legacy `.doc` extraction), strict text read, and platform trash behavior | complete |
| Logs                          | `log-domain.ts` implements bounded log enumeration and 2 MiB reads while Electron retains ordered log persistence and export dialogs                                                        | complete |
| Petdex                        | `petdex.ts` implements opt-in state, loopback-only token-authenticated delivery, serialized requests, status events, test state, cancellation, and SSH/SFTP activity arbitration            | complete |
| Default routing               | `core-router.ts` selects all four Stage 2 domains for Node, preserves whole-domain rollback, and keeps all later domains on Rust                                                            | complete |
| Public compatibility          | Schema v1, Renderer, and Preload sources are unchanged                                                                                                                                      | complete |

## Filesystem guarantees

- All scans and recursive copies use asynchronous filesystem operations and yield between entries.
- Copy operations register a unique operation identity before I/O. Cancellation is checked before
  every later directory entry or file write, pending work stops, and the registry is released.
- `overwrite`, `replace`, `skip`, and `fail` policies preserve the Rust behavior, including
  self-copy no-ops, descendant rejection, conflict errors, and already-completed entries when a
  later source fails.
- Preview reads are bounded at 256 KiB for ordinary files and 16 MiB for complete-file formats.
  UTF-8, UTF-16 BOM, binary detection, Base64, truncation, and oversized metadata-only results
  retain the v1 wire shape.
- Directory results use portable slash paths and Rust byte ordering. Tests include macOS Unicode,
  Windows long-path strings, drive separators, and UNC identities.
- Trash uses the platform recycle facility; test coverage redirects it to an isolated directory.

## Differential and failure evidence

- Real Rust and Node processes read equivalent isolated fixtures and produce matching normalized
  directory, text, binary-preview, missing/invalid text, log, health identity, and Petdex results.
- Mutating differential runs use separate fixture trees; copy, conflict, paste, and final recursive
  filesystem snapshots match without dual-writing one resource.
- Fault tests cover partial copy failure, duplicate/active operation boundaries, mid-copy
  cancellation, no writes after cancellation, malformed protocol, child crash, backpressure, and
  hard shutdown.
- A 300-entry recursive copy runs concurrently with a health request to prove control-channel
  responsiveness while filesystem work is active.
- The Electron smoke runs with Stage 2 defaults and invokes the real Node-backed local-fs path
  through the unchanged 141-command Preload surface while Rust continues to own terminal/storage.

## Verification record

- `pnpm test:desktop`: 51 tests passed.
- `pnpm test:core-stage2`: real Rust/Node differential and isolated write-state comparison passed.
- `pnpm contract:check`: 141 commands and 14 domains verified.
- `pnpm check:desktop`: executable preload, schemas, routing, fixtures, and event visibility verified.
- `pnpm test`: 1,319 tests passed and 1 test was skipped.
- `pnpm test:native`: 682 tests passed and 27 environment-gated tests were ignored.
- `pnpm build`: passed.
- `pnpm lint`: passed with zero warnings.
- `pnpm format:check` and `cargo fmt --check`: passed.
- `pnpm test:desktop:smoke`: native lifecycle, Stage 1 canary, Stage 2 differential,
  default Node domain calls through Renderer, local terminal, and SFTP navigation passed.
- `pnpm electron:pack` and `node scripts/electron-smoke.ts --packaged`: unpacked macOS arm64
  package passed with all four Stage 2 domains defaulting to the app.asar-hosted Node Core. Local
  code signing was unavailable and therefore intentionally skipped.
- `git diff --check`: passed.

## Exit decision

All Stage 2 exit conditions and final verification gates pass. Stage 3 work is intentionally
absent.
