# Stage 6 completion record

Date: 2026-09-09

Scope: Agent Session lifecycle, v5 event storage and projection, model turns, Inbox, tools, user
questions, target-bound references, artifacts, recovery, child Agents, and Fleet coordination.
Rust Core remains packaged for Stage 7 whole-domain rollback.

## Ownership decision

The complete `agent-runtime` domain now defaults to Node: 42 commands total. Together with Stages
2–5, 135 commands across thirteen domains are Node-owned by default. `agent-runtime:rust` rolls the
whole domain back; individual Agent commands cannot be split. A Node Agent route requires Node LLM,
storage, credentials, local filesystem, and all connection domains so one backend owns every Agent
Session, target adapter, cancellation registry, and side effect.

## Deliverables

| Requirement                    | Evidence                                                                                                                                                                                                                                                                     | Status   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Immutable model and projection | `agent-types.ts` and the pure `agent-projection.ts` rebuild headers, status, Inbox, surface, task, compaction, archive, and recovery from v5 events.                                                                                                                         | complete |
| Durable Session store          | `agent-store.ts` validates every event against frozen Schema v1, serializes per-Session appends, fsyncs JSONL before publication, bounds logs/artifacts, makes archives read-only, truncates only a malformed final record, and quarantines middle corruption with evidence. | complete |
| Lifecycle and Inbox            | `agent-runtime.ts` implements create/start/get/list/events/archive, follow-up, steering, injection, CAS Inbox mutation, rename, model and permission selection, interrupt, cancel, and resume for all public command names.                                                  | complete |
| Model loop and questions       | Stage 5 provider adapters drive bounded multi-Step Turns. Tool results and `nextStep` steering continue the same Turn. Durable questions validate exact identity and bounded answers before continuation.                                                                    | complete |
| Tool safety                    | The registry applies closed argument shapes, target confinement, capability/effect checks, exact approval identity, one dispatch record before execution, cancellation, output redaction, and artifact spill for large untrusted results.                                    | complete |
| Target adapters                | Local filesystem and shell execution are root-bound. Remote reference discovery and tool reads use the Stage 4 SFTP pool; remote commands use the trusted SSH connector and stored profile credentials. File references pin target/root identity and reject drift.           | complete |
| Images and artifacts           | Stage 5 image normalization is reused for prepare/submit/preview/cancel. Image and artifact reads require a Session-owned reference and enforce byte limits.                                                                                                                 | complete |
| Recovery and compaction        | Projection exposes in-flight idempotency checkpoints. Resume, reconcile, abort, completed-Turn compaction, archive, startup bad-tail recovery, and crash evidence are durable commands/events.                                                                               | complete |
| Child Agents and Fleet         | Child target/capability scope cannot exceed the parent. Spawn, input, inspect, deepest-first cancel, canary/wave planning, pause/resume/abort, evidence reconciliation, and bounded concurrent admission are durable.                                                        | complete |
| Routing and compatibility      | All 42 commands route to Node as one domain. Schema v1, Renderer, Preload, and IPC names remain unchanged; dependency-incoherent backend selections fail at router construction.                                                                                             | complete |

## Differential and failure evidence

- `electron/tests/node-core-stage6.test.ts` covers restart and archive, malformed-tail evidence,
  CAS and repeated submissions, paging, images, target-bound local references, Skill discovery,
  artifacts, child/Fleet scope, command-value schemas, provider Turn events, approval identity and
  exactly-once dispatch, durable questions, and same-Turn continuation.
- `scripts/stage6-differential-smoke.ts` uses separate Rust and Node roots and compares normalized
  create, follow-up, permission, rename, projection, event paging, list, and archive results. CI runs
  it only after the Rust suite has built the baseline binary.
- Model output and tool output are treated as untrusted data. Unknown tools and extra arguments are
  rejected; sensitive reads and state changes pass capability/effect policy; diagnostics and result
  objects are redacted before event publication.
- A state-changing tool receives an exact `(session, turn, step, request, call, approval)` identity.
  Repeated decisions return the committed state, mismatched identities fail, and only the durable
  `tool/execution: dispatched` transition may precede the side effect.

## Platform and verification record

- `pnpm electron:compile`: passed.
- `node --test dist-electron/tests/node-core-stage6.test.js`: 8 tests passed.
- `node --test dist-electron/tests/core-router.test.js dist-electron/tests/node-core-stage6.test.js`:
  20 tests passed after adding the question continuation case.
- `scripts/stage6-differential-smoke.ts`: passed against the locally built Rust Core and Node Core
  with separate roots. This workstation used its installed static OpenSSL via
  `OPENSSL_NO_VENDOR=1`; no repository build setting was changed.
- `pnpm lint`, `pnpm contract:check`, `pnpm test` (1,319 passed, 1 skipped), and `pnpm build`:
  passed.
- `pnpm test:desktop`: 68 passed, 14 failed, 1 skipped on this Windows/Node 26 workstation.
  All eight Stage 6 tests passed. Existing failures are confined to native child `spawn EFTYPE`,
  Stage 2 Windows path expectations, ConPTY timing, and Stage 5 Windows `fsync EPERM`.
- `pnpm test:native`: 670 passed, 3 failed, 26 ignored. The three failures are existing Windows
  `Access denied (os error 5)` backup/checkpoint filesystem cases; the remaining Agent Runtime
  lifecycle, tool, question, child, Fleet, recovery, and archive tests passed.
- Isolated SSH/SFTP, Windows ConPTY, macOS packaging/signing, and live-provider checks remain the
  platform gates defined by the existing quality workflow; ordinary Agent tests are offline.

## Exit decision

Stage 6 implementation and the local Rust/Node differential pass. The whole Agent domain defaults
to Node and retains one Rust rollback switch. Stage 7 may begin only after the mandatory CI platform
jobs pass; Rust sources, Cargo scripts, and the packaged fallback are intentionally retained until
then.
