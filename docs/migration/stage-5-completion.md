# Stage 5 completion record

Date: 2026-09-09

Scope: LLM provider configuration, model catalog and routes, provider streaming, replay, usage,
session conversion, and image preparation. Agent Runtime remains Rust-owned; Stage 6 work is
intentionally absent.

## Ownership decision

The complete `llm` domain now defaults to Node: 9 commands total. Together with Stages 2–4, 93
commands across twelve domains are Node-owned by default. `llm:rust` rolls the entire domain back;
individual LLM commands cannot be split. A Node LLM route requires Node storage and credentials,
so route documents, credential journals, keychain references, and image blobs have one writer.
The Rust Agent domain uses a read-only durable-snapshot bridge at model-preparation boundaries, so
it observes Node route changes without writing or caching a competing route document.

The Rust Agent Runtime remains a Stage 6 resource. Its embedded model dependency is retained only
inside the still-Rust Agent domain; no Agent command or session lifecycle was migrated in this
stage. Node's prepared-request and streaming boundary is ready for that later handoff without
changing Renderer, Preload, or Schema v1.

## Deliverables

| Requirement          | Evidence                                                                                                                                                                                                                                                                                                                                                       | Status   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Provider and catalog | `llm-catalog.ts` loads the packaged version-1 catalog, reproduces exact profile and endpoint rules, validates explicit model declarations, applies reasoning/output limits, and matches all 54 Rust resolved-model fixtures.                                                                                                                                   | complete |
| Route ownership      | `llm-routes.ts` owns versioned snapshots, legacy conversion, per-route revisions, default selections, replay-domain identity, database CAS, and credential recovery journals. Secret rotation publishes a new keychain reference only with the committed route revision.                                                                                       | complete |
| Nine commands        | `llm-domain.ts` implements all `ai_*` commands in the manifest, including model discovery, route/model listing and resolution, route save, declaration templates, migration listing, and v4→v5 conversion.                                                                                                                                                     | complete |
| Streaming runtime    | `llm-runtime.ts` implements bounded SSE and NDJSON parsing for Responses, Chat Completions, Ollama, and Anthropic Messages; request-header/first-byte/idle timeouts; abort propagation; capped retry hints and jitter; normalized typed failures; output/reasoning request shaping; and normalized stream deltas.                                              | complete |
| Usage and replay     | Provider-specific usage fields normalize without converting unknown values to zero. Successful responses retain bounded provider response/block metadata plus their offline recording, and prepared snapshots bind route revision, model capability, replay domain, content hash, image references, timeout, and retry facts without credentials or data URLs. | complete |
| Session conversion   | `llm-migration.ts` preserves v4 logs, creates a durable v4 backup, uses an exclusive marker, validates sequence/tool/image/snapshot facts, and publishes v5 JSONL without overwrite. Repeated conversion validates the destination and reports `alreadyConverted`.                                                                                             | complete |
| Images               | `llm-images.ts` uses the shared vision contract and `sharp` to validate MIME/base64/container facts, reject animation/profile/pixel bombs, apply orientation, resize, emit RGBA PNG, content-address blobs, prevent symlink following, verify reads, generate previews, and enforce model request budgets.                                                     | complete |
| Public compatibility | Contract Schema v1 and all 141 command names remain unchanged. Renderer and Preload sources were not changed; development and packaged Electron call `ai_list_routes` through the original bridge.                                                                                                                                                             | complete |

## Differential and failure evidence

- `electron/tests/fixtures/llm-recordings.json` contains offline recordings for all four adapters.
  Their normalized text, reasoning, tool/usage deltas, finish reasons, and replay records are compared
  against the Rust-normalized golden sequence without contacting a provider.
- `scripts/stage5-differential-smoke.ts` runs separate Rust and Node roots. It compares all nine
  commands, all 54 catalog resolutions, route/model output after normalizing only generated UUIDs,
  model discovery through a loopback fixture, migration status/result, and published v5 events.
- Retry coverage includes a 503 followed by success, server delay caps, deterministic jitter,
  authentication/rate-limit/context classification, request cancellation during a live stream,
  first-byte and idle deadlines, response/frame/total byte limits, and unknown-versus-zero usage.
- Route tests prove stale writers fail with `REVISION_CONFLICT`, ephemeral discovery keys never
  persist, API keys never enter SQLite or returned snapshots, and client-supplied credential
  references cannot replace a committed reference.
- Migration tests prove source bytes and backup bytes remain unchanged, a valid destination is
  idempotent, a corrupt or partial conversion never publishes, and stale markers are cleaned only
  after a verified destination exists.
- Image tests cover count/base64/MIME/container/pixel/animation/profile/output boundaries,
  content-addressed publication, tamper detection, preview generation, cancellation, and the
  two-import concurrency cap. The original Stage 6 submission commands remain Rust-owned.

## Platform and packaging evidence

- macOS arm64 development Electron starts Node LLM through the unchanged bridge and retains the
  existing terminal, SFTP, storage, credential, and Renderer flows.
- The packaged macOS arm64 app loads the catalog and vision assets from `dist-electron`, loads the
  `sharp` native runtime through Electron 44 packaging, starts Node LLM, and returns the version-1
  empty route document through Renderer IPC. Local signing was unavailable and intentionally
  skipped.
- The mandatory `windows-2025` job runs every desktop Stage 5 test, including the platform-selected
  `sharp` binary and Node LLM initialization. The same job now runs the Rust/Node Stage 5
  differential after the Rust suite. This workstation cannot truthfully record that external
  Windows result; it remains a required CI acceptance signal.
- `scripts/node-llm-live-smoke.mjs` is opt-in through explicit provider/body JSON and an optional
  key. With no configuration it prints an explicit `SKIP`; ordinary tests never require a live
  provider.

## Verification record

- `pnpm test:desktop`: 74 tests passed.
- `pnpm test`: 1,319 tests passed and 1 test was skipped.
- `pnpm test:native`: 683 tests passed and 27 environment-gated tests were ignored.
- `pnpm test:core-stage5`: all nine command, catalog, migration, and normalized recording
  differentials passed.
- `pnpm test:desktop:smoke`: native lifecycle, Stages 1–3 and 5 differential checks, Node default
  routing, original UI terminal/SFTP navigation, and Electron shutdown passed.
- `pnpm build`, `pnpm electron:pack`, and `node scripts/electron-smoke.ts --packaged`: passed on
  macOS arm64.
- `node scripts/node-llm-live-smoke.mjs`: explicitly skipped because no live provider was
  configured.
- `pnpm lint`, `pnpm format:check`, `pnpm contract:check`, and `git diff --check`: passed.

## Exit decision

Stage 5 implementation and every test executable on this macOS environment pass. The
`windows-2025` desktop and differential jobs remain mandatory before merge or release. Stage 6 is
not present, and Rust Core remains packaged for whole-domain rollback.
