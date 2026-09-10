require('node:child_process').execFileSync(
  process.execPath,
  ['electron/build-command-types.ts', '--check'],
  { stdio: 'inherit' },
);
// Verify the checked-in schema, bridge, routing and frozen baseline without parsing Rust.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const Ajv = require('ajv');
const contract = require('../electron/contract.json');
const generatedNames = require('../electron/commands.json');
const argsSchema = require('../electron/contracts/v1/command-args.schema.json');
const valuesSchema = require('../electron/contracts/v1/command-values.schema.json');
const eventPayloadsSchema = require('../electron/contracts/v1/event-payloads.schema.json');
const manifest = require('../electron/contracts/v1/manifest.json');
const fixtureIndex = require('../electron/contracts/v1/fixtures.json');

const names = Object.keys(argsSchema.definitions.CommandArgs.properties);

assert.deepEqual([...new Set(names)].sort(), contract.map((c) => c.command).sort());
assert.deepEqual(generatedNames, names);
assert.deepEqual(names, Object.keys(valuesSchema.definitions.CommandValues.properties));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.commandCount, names.length);
assert.deepEqual(
  manifest.commands.map((command) => command.name),
  names,
);
for (const schema of [argsSchema, valuesSchema, eventPayloadsSchema]) {
  assert.equal(schema['x-shellspan-contract-version'], 1);
  new Ajv({ allowUnionTypes: true, strict: false }).compile(schema);
}
for (const fixture of fixtureIndex.fixtures) {
  const bytes = fs.readFileSync(fixture.path);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    fixture.sha256,
    `Golden fixture drift: ${fixture.path}`,
  );
}
const coreSources = fs
  .readdirSync('electron/node-core', { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => fs.readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8'))
  .join('\n');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('dist-electron/preload.cjs', 'utf8');
for (const command of contract) {
  assert.ok(
    preload.includes(JSON.stringify(command.command)),
    `preload missing ${command.command}`,
  );
  assert.ok(
    (manifest.commands.find((entry) => entry.name === command.command).currentOwner === 'node'
      ? coreSources
      : main
    ).includes(command.command),
    `dispatcher missing ${command.command}`,
  );
}
assert.doesNotMatch(fs.readFileSync('package.json', 'utf8'), /@tauri-apps\//);
console.log(
  `Verified ${names.length} commands: ${manifest.commands.filter((c) => c.currentOwner === 'node').length} Node Core, ${manifest.commands.filter((c) => c.currentOwner === 'electron').length} Electron.`,
);

const { rendererEvents, isRendererEvent } = require('../dist-electron/events.js');
const events = require('../electron/event-contract.json');

const fixedEventNames = Object.keys(
  eventPayloadsSchema.definitions.DesktopEventPayloads.properties,
);

assert.equal(events.businessEvents.length, 15);
assert.deepEqual(rendererEvents, fixedEventNames);
assert.deepEqual(require('../electron/events.json'), fixedEventNames);

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
  'Verified executable preload surface, fixed-B signatures, Node Core routing and event visibility.',
);
