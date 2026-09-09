# Electron host

Electron runtime code lives in `electron/*.ts` and is checked with TypeScript's
`strict` option. Build, development, and smoke-test scripts use `.ts` and run with Node 24's
built-in TypeScript support; they are also type-checked before each build.

- `pnpm electron:compile` checks the tooling, compiles the host to `dist-electron/`,
  bundles the sandbox preload, and regenerates the renderer command types.
- `pnpm electron:dev` compiles the host, builds the Rust core, starts Vite, and
  launches Electron.
- `pnpm build` builds both the Electron host and renderer.
- `pnpm test:desktop` compiles the host and runs the existing Node regression tests
  against the emitted runtime. Test sources and fixtures also use `.ts`.
- `pnpm check:desktop` compiles the host and verifies the command/event contracts.
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

Relative source imports use `.ts`; TypeScript rewrites them to `.js` in the
compiled CommonJS runtime and tests via `rewriteRelativeImportExtensions`.
