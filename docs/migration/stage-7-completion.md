# Stage 7 completion record

Date: 2026-09-10

Scope: make Node Core the only application Core, remove the Rust build and packaged executable,
preserve wire/data compatibility, and replace release and platform gates with Node-only equivalents.

## Ownership and rollback decision

All 134 Core commands across thirteen domains are now immutable Node Core ownership. The seven
desktop/window commands run in Electron Main. Production ignores the test-only domain selector,
and the retired backend and canary selectors are rejected by the Node-only source gate.

Rollback is release-level after the cleanup: the previous stable dual-Core installer and update
artifacts remain the recovery point for one observation cycle. A single installation never starts
two writers and a Node-only package cannot route a live domain back to the removed process. Database
v1-v7 backups, Session v5 files, system credential service/account names, and the frozen Schema v1
wire contract remain compatible with the previous stable release.

## Deliverables

| Requirement                 | Evidence                                                                                                                                                                                                                  | Status   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Single Core startup         | `electron/main.ts` recovers the database, starts one `NodeCoreBackend`, waits for readiness, and preserves protocol-v1 terminal flow and acknowledged shutdown.                                                           | complete |
| Fixed ownership             | `electron/node-core/state.ts` enables all domains in production; `node-core-stage7.test.ts` proves 134 Node and seven Electron commands and limits partial domains to explicit test mode.                                 | complete |
| Upgrade compatibility       | Node Core implements the private, bounded `migration-read` transport against the existing preferences table; the Stage 7 test covers Unicode snapshot import and invalid-key rejection.                                   | complete |
| Rust removal                | The Rust source tree, Cargo manifests/lockfile/toolchain, vendored crates, adapter/router, differential tools, native scripts, and cache workflow are deleted. Product icons, Skills, and golden fixtures were relocated. | complete |
| Node-only build and package | Package scripts and electron-builder no longer invoke Cargo or add a standalone Core resource. `after-pack.ts` rejects the obsolete resource directory.                                                                   | complete |
| CI replacement              | `quality-gate.yml` runs frontend audit, Windows/macOS Node Core desktop tests and unpacked packaging, plus isolated Ubuntu Node SSH/SFTP E2E.                                                                             | complete |
| Release chain               | `release.yml`, version bumping, and release metadata use only Node/pnpm and verify package contents before upload.                                                                                                        | complete |
| Regression guard            | `check-node-only.mjs` rejects restored Cargo/build/binary/backend-selector references; `verify-node-only-package.mjs` verifies `app.asar` and absence of the old executable.                                              | complete |

## Compatibility and safety

- Renderer, Preload, all 141 command names, argument/value schemas, events, terminal sequencing, and
  IPC sender verification are unchanged.
- Node storage continues the staged backup/restore and unsupported-schema refusal rules. The private
  WebView migration reader exposes only the three allowlisted key forms and 256 Ki-character chunks.
- Credential storage continues the old service/account namespace migration without putting secrets
  in SQLite or diagnostics.
- The frozen Rust baselines remain as historical evidence. Their capture and differential tools are
  intentionally absent from active development and release paths.
- Icons live in `resources/icons`; bundled Agent Skills live in `src/lib/ai/skills`; contract fixtures
  live under `electron/tests/fixtures` so no product resource depends on the removed tree.

## Verification gates

The implementation is accepted when the following pass on the Stage 7 tree:

- `pnpm check:node-only`, `pnpm contract:check`, `pnpm check:desktop`.
- `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm test:desktop`, and `pnpm build`.
- `pnpm electron:pack` followed by `node scripts/verify-node-only-package.mjs` on the local platform.
- Mandatory CI: Windows 2025 and macOS 15 desktop/package jobs, plus Ubuntu isolated SSH/SFTP E2E.

## Recorded implementation verification

The Stage 7 tree was exercised locally on Windows x64 with Node 26 on 2026-09-10:

- Node-only, generated-contract, and desktop ownership gates passed for all 141 commands (134 Node
  Core and seven Electron Main).
- ESLint passed, Prettier passed with checkout-native line endings, and the frontend suite passed
  1,319 tests across 154 files with one intentional skip.
- The desktop suite passed 72 tests with zero failures and one Unix-only abnormal-exit test skipped
  on Windows. The Windows PTY test verifies that normal close removes the full ConPTY process tree.
- The isolated Docker SSH/SFTP run passed direct and jump-host SSH, terminal, forwarding, health,
  recursive and concurrent transfers, owner resolution, mutations, and cancellation.
- A fresh Windows x64 unpacked application passed the 326-file package audit and the packaged
  Electron smoke. That smoke exercised legacy localStorage and IndexedDB import, the unchanged
  141-command bridge, storage and credentials, Node Core IPC, terminal, SFTP, settings, and clean
  shutdown with no standalone Core executable in the package.

The Windows/macOS jobs repeat desktop tests, package inspection, and packaged application smoke on
their target architecture. Their hosted-run results, signing/notarization, updater publication, and
the stable observation window are release evidence rather than local source-tree evidence.

Signing, notarization, updater publication, and one full stable observation cycle remain operational
release actions. They cannot be manufactured by a source change; promotion owners must retain the
previous stable artifacts until that cycle closes.
