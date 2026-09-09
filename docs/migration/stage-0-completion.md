# Stage 0 completion record

Date: 2026-09-09

Scope: contract freeze and baseline establishment for the Rust Core to Node Core migration.

## Deliverables

| Requirement                                                                                     | Evidence                                                                                                                     | Status   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| Every desktop command has a versioned argument and value schema                                 | `electron/contracts/v1/command-args.schema.json` and `command-values.schema.json`; 141 properties in each                    | complete |
| Every Renderer event has a payload schema                                                       | `event-payloads.schema.json`; 17 fixed events plus `ssh-data:${sessionId}`                                                   | complete |
| Every command has an owner, domain, resource set, dependency set, event list, and test evidence | `manifest.json` and `docs/migration/command-responsibility-matrix.md`                                                        | complete |
| TypeScript command/event types derive from the frozen contract                                  | `electron/build-command-types.ts` generates `generated-contract-types.ts`, `contract.ts`, `commands.json`, and `events.json` | complete |
| Runtime validation no longer delegates all deep validation to Rust                              | `electron/validation.ts` performs JSON-safety checks and Ajv schema validation before dispatch                               | complete |
| Serde edge behavior is frozen                                                                   | 24 Tauri/Serde cases plus schema parity tests in `electron/tests/contract-schema.test.ts`                                    | complete |
| Command, event, Agent, LLM, and image golden fixtures are indexed                               | `electron/contracts/v1/fixtures.json` with SHA-256 drift checks                                                              | complete |
| Security boundaries are explicit                                                                | `docs/migration/security-boundaries.md`                                                                                      | complete |
| Startup, memory, IPC, PTY, local-copy, SFTP, and storage baselines exist                        | `scripts/capture-native-core-baseline.ts` and `docs/migration/baselines/native-core-darwin-arm64.json`                       | complete |
| Normal contract generation/checking does not parse Rust                                         | `pnpm contract:generate`, `pnpm contract:check`, and `scripts/check-desktop-contract.cjs` consume schema v1                  | complete |

## Baseline snapshot

The checked-in macOS arm64 baseline was captured on an Apple M4 Pro using Core 2.0.56 and Node 24.15.0. It includes five ready-handshake samples, twenty control requests, ten PTY round trips, 16 MiB local/SFTP transfers, terminal lifecycle ordering, stable error/null/Unicode behavior, and the SQLite v7 schema.

This snapshot is a comparison reference, not a universal performance claim. Node and Rust must be measured back-to-back on the same environment using the budgets in `docs/migration/baselines/README.md`.

## Verification record

The completion audit ran the following gates:

- `pnpm contract:check`: 141 commands and 14 domains verified.
- `pnpm test:desktop`: 33 tests passed.
- `pnpm check:desktop`: executable preload, schema, routing, fixture checksums, and event visibility verified.
- `pnpm test`: 1,319 tests passed and 1 test was skipped.
- `pnpm build`: Electron host, preload, TypeScript, and Renderer production build passed.
- `pnpm test:native`: 682 tests passed and 27 environment-gated tests were ignored.
- `pnpm test:e2e:ssh`: 10 isolated SSH/SFTP, jump-host, forwarding, remote-health, execution, and redaction tests passed.
- `pnpm lint`: passed with zero warnings.
- `pnpm format:check`: passed.
- `git diff --check`: passed.

During baseline restoration, the cross-language Agent Session v5 fixture was recovered from the sibling ShellSpan workspace because the current checkout referenced it but did not contain it. Two stale Rust tests were also corrected: recovery now distinguishes repeated provider call IDs from request-scoped internal call IDs, and the redaction fixture now actually reconstructs the registered secret across the head/tail capture boundary.

## Exit decision

All Stage 0 exit conditions are met. Stage 1 may introduce `CoreBackend`, retain the current Rust implementation as `RustCoreBackend`, and add the first Node Core canary without changing the Renderer contract.
