import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dist-electron');
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, ['electron/build-command-types.ts'], {
  cwd: root,
  stdio: 'inherit',
});
// Type-check the tooling as well as all runtime sources before emitting artifacts.
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.electron-tools.json'], {
  cwd: root,
  stdio: 'inherit',
});
await rm(output, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.electron.json'], {
  cwd: root,
  stdio: 'inherit',
});
await mkdir(output, { recursive: true });
await chmod(path.join(output, 'tests/fixtures/native-child.js'), 0o755);
await chmod(path.join(output, 'node-core/entry.js'), 0o755);
await writeFile(path.join(output, 'package.json'), '{"type":"commonjs"}\n');
// Sandboxed preloads cannot load local modules. Inline the JSON and event allowlist
// into a single CommonJS file, leaving only Electron itself external.
await build({
  root,
  configFile: false,
  build: {
    outDir: output,
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: path.join(root, 'electron/preload.ts'),
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    rolldownOptions: { external: ['electron'] },
  },
});
await rm(path.join(output, 'preload.js'));
