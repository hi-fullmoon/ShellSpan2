import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

assert.ok(existsSync('dist-electron/node-core/entry.js'), 'compiled Node Core entry is missing');

function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? walk(child) : [child];
  });
}

const packaged = walk('release');
assert.ok(
  packaged.some((path) => path.endsWith('app.asar')),
  'packaged app.asar is missing',
);
assert.equal(
  packaged.some((path) => /shellspan-core(?:\.exe)?$/i.test(path)),
  false,
  'obsolete standalone Core binary is present',
);
for (const path of packaged.filter((path) => path.endsWith('app.asar')))
  assert.ok(statSync(path).size > 0, `${path} is empty`);

const addons = packaged.filter((path) => path.endsWith('.node'));
const selectedAddons = addons.filter(
  (path) =>
    path.includes('keytar') ||
    path.includes(join('node-pty', 'prebuilds', `${process.platform}-${process.arch}`)),
);
for (const dependency of ['keytar', 'node-pty'])
  assert.ok(
    selectedAddons.some((path) => path.includes(dependency)),
    `${dependency} native addon is missing from the unpacked application`,
  );
if (process.platform === 'win32') {
  for (const path of selectedAddons) {
    const bytes = readFileSync(path);
    const offset = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ', `${path} is not PE`);
    assert.equal(bytes.readUInt32LE(offset), 0x4550, `${path} has no PE header`);
    const architecture = { 0x8664: 'x64', 0xaa64: 'arm64' }[bytes.readUInt16LE(offset + 4)];
    assert.equal(architecture, process.arch, `${path} architecture does not match Electron`);
  }
} else if (process.platform === 'darwin') {
  for (const path of selectedAddons) {
    const bytes = readFileSync(path);
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, `${path} is not a thin 64-bit Mach-O`);
    const architecture = { 0x1000007: 'x64', 0x100000c: 'arm64' }[bytes.readUInt32LE(4)];
    assert.equal(architecture, process.arch, `${path} architecture does not match Electron`);
  }
}
console.log(
  `Verified ${packaged.length} packaged files contain no obsolete standalone Core binary.`,
);
