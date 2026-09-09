# Electron host

Electron runtime code lives in `electron/*.ts` and is checked with TypeScript's
`strict` option. Build, development, and smoke-test scripts use `.ts` and run with Node 24's
built-in TypeScript support; they are also type-checked before each build.

The migration host starts isolated Rust and Node Core processes behind
`CoreBackendRouter`. Stage 2 defaults `health`, `local-fs`, `logs`, and `petdex` to Node; Stage 3
also defaults `storage` and `credentials` to Node. Later-wave domains remain on Rust.
`SHELLSPAN_CORE_BACKENDS=terminal:node,storage:rust,credentials:rust` selects whole domains; command names and
unknown domains are rejected so stateful lifecycles cannot be split. During Stage 1 only,
`SHELLSPAN_CORE_CANARY=rust|node|compare` selects the stateless, read-only `read_text_file`
canary. When unset, it follows the `local-fs` domain route (Node by default). `compare` invokes
both backends and fails closed if their complete wire responses differ.

`storage` and `credentials` must be selected together because credential metadata is transactional
SQLite state. Domains routed to Rust are not initialized inside Node Core.

- `pnpm electron:compile` generates desktop types and allowlists from
  `electron/contracts/v1`, checks the tooling, compiles the host to
  `dist-electron/`, and bundles the sandbox preload.
- `pnpm electron:dev` compiles the host, builds the Rust core, starts Vite, and
  launches Electron.
- `pnpm build` builds both the Electron host and renderer.
- `pnpm test:desktop` compiles the host and runs the existing Node regression tests
  against the emitted runtime. Test sources and fixtures also use `.ts`.
- `pnpm test:core-canary` builds Rust and both Electron Core hosts, then compares the
  real Rust and Node `read_text_file` responses against one immutable fixture.
- `pnpm test:core-stage2` differentially checks real Rust and Node low-risk local domains,
  including final filesystem state after writes.
- `pnpm test:core-stage3` compares real Rust/Node storage responses and final SQLite state.
- `pnpm storage:restore --database <absolute-path> --backup <absolute-path>` performs an
  explicit offline, integrity-checked database restore.
- `pnpm check:desktop` compiles the host and verifies the command/event contracts.
- `pnpm contract:generate` regenerates TypeScript contract types, command/event
  allowlists, and the migration ownership manifest from contract schema v1.
- `pnpm contract:check` verifies that generated contract artifacts and the
  141-command responsibility matrix are current.
- `pnpm electron:pack` creates an unpacked application with the release Rust core.
- `pnpm format` formats supported project files with the pinned Prettier version;
  `pnpm format:check` checks formatting without writing files. Generated contracts,
  build output, and installed dependencies are excluded in `.prettierignore`.
- `pnpm lint` checks JavaScript and TypeScript files with ESLint. `pnpm lint:fix`
  automatically inserts at least one blank line after the last import, including
  before comments. Generated contracts and build output are excluded.

`dist-electron/` is generated and ignored by Git. Its `package.json` marks the
emitted host as CommonJS. `preload.ts` is bundled into one `preload.cjs` file with
only Electron external, so it can run with `sandbox: true`. Packaging uses the
compiled host and the compiled `after-pack.ts` hook.

Command arguments are deeply validated with Ajv before they reach either Core
backend. The versioned JSON Schemas are authoritative; generated TypeScript
types must not be edited directly. Relative source imports use `.ts`; TypeScript
rewrites them to `.js` in the compiled CommonJS runtime and tests via
`rewriteRelativeImportExtensions`.
