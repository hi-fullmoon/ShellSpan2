# Electron host

Electron runtime code lives in `electron/*.ts` and is checked with TypeScript's `strict` option.
Build, development, and smoke-test scripts use Node 24's built-in TypeScript support and are also
type-checked before each build.

ShellSpan now starts one isolated Node Core process. All 134 Core-owned commands run there; the seven
desktop/window commands remain in Electron Main. The public Renderer, Preload, IPC, command, event,
database, workspace, credential, and Session v5 contracts are unchanged. Production no longer
accepts a per-domain backend selector. Test processes may set `SHELLSPAN_NODE_CORE_TEST_MODE=1` and
`SHELLSPAN_NODE_DOMAINS` to initialize a smaller isolated fixture, but that selector is ignored in
normal development and packaged applications.

- `pnpm electron:compile` generates desktop types and allowlists from `electron/contracts/v1`,
  checks the tooling, compiles the host to `dist-electron/`, and bundles the sandbox preload.
- `pnpm electron:dev` compiles the host, starts Vite, and launches Electron.
- `pnpm build` builds both the Electron host and Renderer.
- `pnpm test:desktop` compiles the host and runs the Node Core and desktop regression tests.
- `pnpm test:desktop:smoke` exercises the real Electron window and isolated Node Core.
- `pnpm storage:restore --database <absolute-path> --backup <absolute-path>` performs an explicit
  offline, integrity-checked database restore.
- `pnpm check:desktop` verifies the command/event contracts and Node Core dispatch ownership.
- `pnpm check:node-only` rejects obsolete Core binaries, build scripts, backend selectors, or a
  restored Rust source tree from active build, runtime, and CI files.
- `pnpm contract:generate` regenerates TypeScript contract types, command/event allowlists, and the
  current Node ownership manifest from contract schema v1.
- `pnpm contract:check` verifies generated contract artifacts and the 141-command responsibility
  matrix.
- `pnpm electron:pack` creates an unpacked Node-only application.
- `pnpm test:package` creates that package and verifies it contains the Node Core entry and no
  obsolete standalone Core executable.

`dist-electron/` is generated and ignored by Git. Its `package.json` marks the emitted host as
CommonJS. `preload.ts` is bundled into one `preload.cjs` file with only Electron external, so it can
run with `sandbox: true`. Node Core keeps the protocol-v1 control and terminal channels and the same
bounded startup, request, backpressure, and shutdown behavior previously exercised by the dual-Core
host.

Command arguments are deeply validated with Ajv before they reach Node Core. The versioned JSON
Schemas are authoritative; generated TypeScript types must not be edited directly. Relative source
imports use `.ts`; TypeScript rewrites them to `.js` in the compiled CommonJS runtime.
