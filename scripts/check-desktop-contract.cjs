require('node:child_process').execFileSync(
  process.execPath,
  ['electron/build-command-types.ts', '--check'],
  { stdio: 'inherit' },
);
require('node:child_process').execFileSync('python3', ['scripts/trace-boundary.py', '--check'], {
  stdio: 'inherit',
});
// Verify the checked-in bridge, routing and source baseline without loading Electron.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const contract = require('../electron/contract.json');
const names = require('../electron/commands.json');

assert.deepEqual([...new Set(names)].sort(), contract.map((c) => c.command).sort());
const dispatch = fs.readFileSync('native/src/dispatch.rs', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('dist-electron/preload.cjs', 'utf8');
for (const command of contract) {
  assert.ok(
    preload.includes(JSON.stringify(command.command)),
    `preload missing ${command.command}`,
  );
  assert.ok(
    (command.owner === 'native' ? dispatch : main).includes(command.command),
    `dispatcher missing ${command.command}`,
  );
}
for (const file of ['package.json', 'native/Cargo.toml', 'native/Cargo.lock'])
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /(?:@tauri-apps\/|name = "tauri(?:-|"))/);
console.log(
  `Verified ${names.length} commands: ${contract.filter((c) => c.owner === 'native').length} native, ${contract.filter((c) => c.owner === 'electron').length} Electron.`,
);

const { rendererEvents, isRendererEvent } = require('../dist-electron/events.js');
const events = require('../electron/event-contract.json');

assert.equal(events.businessEvents.length, 15);
for (const event of events.businessEvents)
  assert.ok(isRendererEvent(event.name.replace('${sessionId}', 'test-id')));
for (const event of events.callbacks)
  assert.equal(isRendererEvent(event.name), event.visibility !== 'main-only');
// Execute the actual preload in its sandbox model; inspect exposed functions.
let bridge;
require('node:vm').runInNewContext(preload, {
  require: () => ({
    contextBridge: { exposeInMainWorld: (_n, v) => (bridge = v) },
    ipcRenderer: { on() {}, invoke() {} },
    webUtils: {},
  }),
});

assert.deepEqual(Object.keys(bridge.commands).sort(), [...names].sort());
console.log(
  'Verified executable preload surface, fixed-B signatures, Rust argument routing and event visibility.',
);
