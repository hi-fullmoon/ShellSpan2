import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['package.json', 'electron-builder.yml', 'electron', 'scripts', '.github/workflows'];
const forbidden =
  /\bcargo\b|Cargo\.(?:toml|lock)|shellspan-core|rust-core-backend|SHELLSPAN_CORE_(?:BACKENDS|CANARY)/i;
const extensions = new Set(['.cjs', '.js', '.json', '.mjs', '.py', '.ts', '.tsx', '.yml', '.yaml']);

function files(path) {
  const entry = readdirSync(path, { withFileTypes: true });
  return entry.flatMap((item) => {
    const child = join(path, item.name);
    return item.isDirectory() ? files(child) : [child];
  });
}

const candidates = roots.flatMap((path) =>
  existsSync(path) && !readdirSafe(path) ? [path] : files(path),
);
function readdirSafe(path) {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

for (const path of candidates) {
  if (path.endsWith('check-node-only.mjs') || path.endsWith('verify-node-only-package.mjs'))
    continue;
  const suffix = path.slice(path.lastIndexOf('.'));
  if (path !== 'package.json' && path !== 'electron-builder.yml' && !extensions.has(suffix))
    continue;
  assert.doesNotMatch(
    readFileSync(path, 'utf8'),
    forbidden,
    `obsolete Rust Core reference in ${path}`,
  );
}
assert.equal(existsSync('native'), false, 'the removed Rust source directory must not return');
assert.equal(
  existsSync('rust-toolchain.toml'),
  false,
  'the removed Rust toolchain pin must not return',
);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const name of ['native:build', 'native:release', 'test:native'])
  assert.equal(pkg.scripts[name], undefined, `obsolete package script ${name}`);
console.log(`Verified ${candidates.length} active files use the Node-only Core toolchain.`);
