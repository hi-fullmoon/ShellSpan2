# Desktop contract v1

This directory is the authoritative migration boundary between Electron and the application core.
It freezes the public desktop wire contract before Rust domains are replaced by Node implementations.

## Authoritative files

- `command-args.schema.json`: input shape for all 141 desktop commands.
- `command-values.schema.json`: successful wire value for all 141 commands. Rust `()` is represented as JSON `null`.
- `event-payloads.schema.json`: payloads for 17 fixed renderer events and the dynamic `ssh-data:${sessionId}` event.
- `manifest.json`: command ownership, migration domain, resource ownership, dependencies, events, and test evidence.
- `fixtures.json`: immutable baseline and golden-fixture inventory with SHA-256 checksums.

`src/lib/desktop/generated-contract-types.ts`, `src/lib/desktop/contract.ts`, `electron/commands.json`, and `electron/events.json` are generated from these schemas. Runtime command validation also reads `command-args.schema.json`; Rust Serde is no longer the only deep validation boundary.

## Making a contract change

1. Edit the versioned schemas and `manifest.json`. Do not edit generated TypeScript files.
2. Run `pnpm contract:generate`.
3. Add or update golden fixtures for changed wire behavior.
4. Run `pnpm contract:check`, `pnpm test:desktop`, and `pnpm check:desktop`.
5. If compatibility is intentionally broken, create `contracts/v2` instead of silently changing v1.

Top-level command argument objects intentionally allow unrelated keys to preserve the established Tauri command behavior. Nested records carry `x-serde-unknown-fields` where the Rust snapshot established whether unknown fields are ignored or denied.

## Bootstrap provenance

The v1 schemas were initially snapshotted from the existing TypeScript business wrappers, the fixed Rust command metadata in `electron/contract.json`, and the Serde definitions recorded in `electron/type-contract.json`. `scripts/bootstrap-desktop-contract-schema.mjs` exists only to reproduce that initial snapshot; it is not part of normal contract generation and must not overwrite a reviewed schema change.
