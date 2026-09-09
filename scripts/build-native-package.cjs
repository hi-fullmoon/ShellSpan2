'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'),
  path = require('node:path');

const target = process.argv[2];
if (!['aarch64-apple-darwin', 'x86_64-pc-windows-msvc'].includes(target))
  throw new Error('Unsupported release target');
execFileSync(
  'cargo',
  ['build', '--locked', '--release', '--manifest-path', 'native/Cargo.toml', '--target', target],
  { stdio: 'inherit' },
);
const name = target.includes('windows') ? 'shellspan-core.exe' : 'shellspan-core';
fs.mkdirSync('native/target/release', { recursive: true });
fs.copyFileSync(
  path.join('native/target', target, 'release', name),
  path.join('native/target/release', name),
);
if (!target.includes('windows')) fs.chmodSync(path.join('native/target/release', name), 0o755);
