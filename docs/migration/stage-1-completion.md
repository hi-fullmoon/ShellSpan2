# Stage 1 completion record

Date: 2026-09-09

Scope: dual-backend skeleton. No Stage 2 domain has changed default ownership.

## Deliverables

| Requirement               | Evidence                                                                                                                                                                                                                                   | Status   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Stable backend boundary   | `electron/core-backend.ts` defines readiness, invocation, validation, lifecycle events, terminal flow control, and shutdown                                                                                                                | complete |
| Preserve the Rust host    | `electron/rust-core-backend.ts` adapts the existing `NativeHost`; its framing, 4096-request limit, queued writes, startup watchdog, dedicated terminal channel, sequence checks, and hard shutdown deadline remain in `electron/native.ts` | complete |
| Independent Node Core     | `electron/node-core/entry.ts`, `dispatcher.ts`, `state.ts`, and `events.ts` implement protocol-v1 ready/request/response/event/stop behavior in a separate process                                                                         | complete |
| Failure isolation         | Node Core protocol corruption or an uncaught exception exits only the child; the host rejects pending/future requests and reports the unexpected exit                                                                                      | complete |
| Domain routing            | `electron/core-router.ts` derives all 14 domains and 141 command mappings from Schema v1's manifest and accepts only `domain:rust\|node` entries                                                                                           | complete |
| Stateful ownership        | A route selects an entire domain. Command names are rejected as configuration keys; tests route create/write/resize/close terminal commands together                                                                                       | complete |
| Deterministic canary      | The frozen, stateless, non-mutating `read_text_file` command supports `rust`, `node`, and fail-closed `compare` modes                                                                                                                      | complete |
| Public contract stability | Renderer and Preload sources and the 141-command/17-event Schema v1 are unchanged                                                                                                                                                          | complete |

## Runtime and rollback

Rust owns every domain by default. Domain configuration uses
`SHELLSPAN_CORE_BACKENDS`, for example `terminal:node,storage:rust`. The Stage 1 canary is
controlled separately with `SHELLSPAN_CORE_CANARY=rust`, `node`, or `compare`; the default is
the `local-fs` domain route, which itself defaults to Rust. This one command-level switch is
hard-coded to `read_text_file`, and startup verifies from the frozen manifest that the command
remains stateless and read-only.

The immediate rollback is to remove `node` domain entries and set
`SHELLSPAN_CORE_CANARY=rust` (or unset both variables). No dual writes were introduced: Node
Core has no database, credential, terminal, SSH, SFTP, workspace, or mutating file command.

## Test evidence

The Stage 1 audit covers:

- Core routing configuration, whole-domain stateful routing, migration-read ownership,
  lifecycle forwarding, canary selection, exact comparison, and mismatch rejection.
- Node Core ready, request, response, validation, event, stop, multi-megabyte framed
  backpressure, malformed arguments, uncaught exceptions, pending rejection, and future-call
  rejection.
- A real Rust/Node differential smoke using the same immutable UTF-8 file, invalid UTF-8, and a
  missing path. The complete success and failure wire responses match exactly.
- Existing NativeHost failure, startup timeout, protocol mismatch, terminal sequence, partial
  frame, backpressure, request-limit, and hard-stop regression coverage.

Verification commands and observed results:

- `pnpm contract:check`: 141 commands and 14 domains verified.
- `pnpm check:desktop`: executable preload, schemas, routing, fixture checksums, and event visibility verified.
- `pnpm test:desktop`: 42 tests passed.
- `pnpm test:core-canary`: real Rust/Node canary matched exactly.
- `pnpm test`: 1,319 tests passed and 1 test was skipped.
- `pnpm test:native`: 682 tests passed and 27 environment-gated tests were ignored.
- `pnpm build`: Electron host, Node Core, preload, TypeScript, and Renderer production build passed.
- `pnpm lint`: passed with zero warnings.
- `pnpm format:check`: passed.
- `pnpm test:desktop:smoke`: native lifecycle, exact Rust/Node canary, real Electron
  Renderer-to-both-backends invocation, local terminal, and SFTP navigation passed.
- `pnpm electron:pack` and `node scripts/electron-smoke.ts --packaged`: unpacked macOS arm64
  package passed the same Renderer-to-Rust/Node canary, proving that the Node Core entry starts
  correctly from app.asar. Code signing was intentionally unavailable in the local test environment.
- `git diff --check`: passed.

## Exit decision

All Stage 1 dual-backend exit conditions and final verification gates pass. Stage 2 work is
intentionally absent.
