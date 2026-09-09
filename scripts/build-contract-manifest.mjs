import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractDirectory = path.join(root, 'electron/contracts/v1');
const argsSchema = JSON.parse(
  await readFile(path.join(contractDirectory, 'command-args.schema.json'), 'utf8'),
);
const valuesSchema = JSON.parse(
  await readFile(path.join(contractDirectory, 'command-values.schema.json'), 'utf8'),
);
const eventsSchema = JSON.parse(
  await readFile(path.join(contractDirectory, 'event-payloads.schema.json'), 'utf8'),
);
const legacy = JSON.parse(await readFile(path.join(root, 'electron/contract.json'), 'utf8'));
const legacyByName = new Map(legacy.map((entry) => [entry.command, entry]));
const commandNames = Object.keys(argsSchema.definitions.CommandArgs.properties);

const domainDefinitions = {
  'agent-runtime': {
    wave: 6,
    resources: ['agentSessions', 'eventStore', 'artifacts', 'toolRuntime'],
    dependencies: ['llm', 'terminal', 'remote-fs', 'local-fs', 'credentials'],
    tests: ['native/src/agent_runtime/*_tests.rs', 'src/lib/ai/__tests__'],
  },
  llm: {
    wave: 5,
    resources: ['httpClients', 'routeStore', 'providerStreams', 'imageStore'],
    dependencies: ['storage', 'credentials'],
    tests: ['native/src/llm/tests.rs', 'native/src/llm/catalog_tests.rs'],
  },
  terminal: {
    wave: 4,
    resources: ['sshSessions', 'localPtys', 'terminalGuard'],
    dependencies: ['host-trust', 'credentials'],
    tests: ['native/src/session.rs', 'scripts/native-smoke.ts'],
  },
  'remote-fs': {
    wave: 4,
    resources: ['sftpPool', 'transferRegistry', 'directoryRequests'],
    dependencies: ['host-trust', 'credentials'],
    tests: ['native/src/remote_fs.rs', 'tests/ssh-e2e'],
  },
  'remote-health': {
    wave: 4,
    resources: ['remoteHealthRequests', 'sshConnections'],
    dependencies: ['host-trust', 'credentials'],
    tests: ['native/src/remote_health.rs', 'tests/ssh-e2e'],
  },
  'port-forward': {
    wave: 4,
    resources: ['portForwards', 'listeners', 'sshConnections'],
    dependencies: ['host-trust', 'credentials'],
    tests: ['native/src/port_forward.rs', 'tests/ssh-e2e'],
  },
  'host-trust': {
    wave: 4,
    resources: ['knownHosts', 'preflightRequests'],
    dependencies: ['credentials'],
    tests: ['native/src/known_hosts.rs', 'native/src/connection.rs'],
  },
  storage: {
    wave: 3,
    resources: ['sqlite', 'workspaceFiles'],
    dependencies: [],
    tests: ['native/src/db.rs', 'native/src/data_migration.rs'],
  },
  credentials: {
    wave: 3,
    resources: ['systemKeychain', 'sqliteMetadata'],
    dependencies: ['storage'],
    tests: ['native/src/keychain.rs'],
  },
  'local-fs': {
    wave: 2,
    resources: ['localFilesystem', 'trash'],
    dependencies: [],
    tests: ['native/src/local_fs.rs'],
  },
  logs: {
    wave: 2,
    resources: ['logDirectory'],
    dependencies: ['local-fs'],
    tests: ['electron/tests/logs.test.ts'],
  },
  health: {
    wave: 2,
    resources: ['systemMetrics'],
    dependencies: [],
    tests: ['native/src/health.rs'],
  },
  petdex: {
    wave: 2,
    resources: ['petdexSocket'],
    dependencies: [],
    tests: ['native/tests/petdex_contract_probe.rs'],
  },
  desktop: {
    wave: 1,
    resources: ['electronApp', 'nativeDialogs'],
    dependencies: [],
    tests: ['electron/tests/preload.test.ts', 'electron/tests/boundary.test.ts'],
  },
};

const sets = {
  terminal: new Set([
    'create_session',
    'create_local_session',
    'write_session',
    'get_session_status',
    'mark_session_ready',
    'set_session_output_paused',
    'resize_session',
    'close_session',
  ]),
  remoteHealth: new Set(['collect_remote_health_snapshot', 'cancel_remote_health_snapshot']),
  hostTrust: new Set([
    'check_host_key',
    'preflight_connection',
    'cancel_connection_preflight',
    'trust_host',
    'list_known_hosts',
    'remove_known_host',
  ]),
  localFs: new Set([
    'copy_local_paths',
    'list_local_directory',
    'open_path',
    'paste_local_paths',
    'preview_local_file',
    'read_text_file',
    'rename_local_path',
    'trash_local_paths',
  ]),
  logs: new Set(['list_log_files', 'read_log_file', 'export_log_file']),
  storage: new Set([
    'add_profile',
    'update_profile',
    'remove_profile',
    'list_profiles',
    'load_preferences',
    'save_preferences',
    'list_recent_profiles',
    'touch_recent_profile',
    'remove_recent_profile',
    'list_sftp_bookmarks',
    'add_sftp_bookmark',
    'remove_sftp_bookmark',
    'load_terminal_workspace',
    'save_terminal_workspace',
    'clear_terminal_workspace',
    'load_sftp_workspace',
    'save_sftp_workspace',
    'clear_sftp_workspace',
  ]),
  desktop: new Set([
    'pick_local_files',
    'pick_local_folder',
    'pick_private_key_file',
    'open_url',
    'request_app_exit',
    'request_app_restart',
  ]),
};

function domainFor(name) {
  if (name.startsWith('agent_runtime_')) return 'agent-runtime';
  if (name.startsWith('ai_')) return 'llm';
  if (sets.terminal.has(name)) return 'terminal';
  if (sets.remoteHealth.has(name)) return 'remote-health';
  if (name.includes('port_forward')) return 'port-forward';
  if (sets.hostTrust.has(name)) return 'host-trust';
  if (
    name.includes('key_credential') ||
    name.includes('profile_password') ||
    name.includes('profile_secret')
  )
    return 'credentials';
  if (sets.localFs.has(name)) return 'local-fs';
  if (sets.logs.has(name)) return 'logs';
  if (sets.storage.has(name)) return 'storage';
  if (sets.desktop.has(name)) return 'desktop';
  if (name.startsWith('petdex_')) return 'petdex';
  if (name === 'get_system_health') return 'health';
  if (
    /remote|upload|download|sftp|delete/.test(name) ||
    ['cancel_upload', 'cancel_download', 'cancel_delete'].includes(name)
  )
    return 'remote-fs';
  throw new Error(`Unclassified desktop command: ${name}`);
}

function emittedEvents(name, domain) {
  if (domain === 'terminal')
    return ['ssh-status', 'ssh-closed', 'ssh-session-error', 'ssh-data:${sessionId}'];
  if (domain === 'agent-runtime') return ['agent-runtime-session-event'];
  if (domain === 'port-forward') return ['port-forward-event'];
  if (domain === 'petdex') return ['petdex-status'];
  if (name.includes('upload')) return ['upload-progress'];
  if (name.includes('download')) return ['download-progress'];
  if (name.includes('delete')) return ['delete-progress'];
  if (name.includes('remote_copy') || name === 'copy_remote_to_remote')
    return ['remote-copy-progress'];
  return [];
}

function mutates(name) {
  return !/^(ai_list|ai_resolve|ai_model|agent_runtime_get|agent_runtime_list|agent_runtime_inspect|check_|get_|list_|load_|preview_|read_|retrieve_|resolve_)/.test(
    name,
  );
}

const commandValues = valuesSchema.definitions.CommandValues.properties;
assert.deepEqual(commandNames, Object.keys(commandValues));
const commands = commandNames.map((name) => {
  const baseline = legacyByName.get(name);
  assert.ok(baseline, `Missing legacy provenance for ${name}`);
  const domain = domainFor(name);
  const definition = domainDefinitions[domain];
  return {
    name,
    currentOwner: baseline.owner,
    source: baseline.source,
    domain,
    migrationWave: definition.wave,
    stateful: definition.resources.some((resource) =>
      /Sessions|Ptys|Pool|Registry|Requests|Forwards|Store|sqlite|Keychain|workspace/i.test(
        resource,
      ),
    ),
    mutates: mutates(name),
    resources: definition.resources,
    dependencies: definition.dependencies,
    emits: emittedEvents(name, domain),
    argsSchema: `command-args.schema.json#/definitions/CommandArgs/properties/${name}`,
    valueSchema: `command-values.schema.json#/definitions/CommandValues/properties/${name}`,
    testEvidence: definition.tests,
  };
});

const fixedEvents = Object.keys(eventsSchema.definitions.DesktopEventPayloads.properties);
const manifest = {
  schemaVersion: 1,
  commandCount: commands.length,
  fixedEventCount: fixedEvents.length,
  dynamicEvents: ['ssh-data:${sessionId}'],
  domains: domainDefinitions,
  commands,
  securityBoundaries: [
    'ipc-sender-verification',
    'command-schema-validation',
    'host-key-before-credentials',
    'system-keychain-secret-storage',
    'secret-log-redaction',
    'agent-tool-permission',
    'filesystem-path-scope',
    'terminal-backpressure',
  ],
};

const counts = Object.fromEntries(
  Object.keys(domainDefinitions).map((domain) => [
    domain,
    commands.filter((command) => command.domain === domain).length,
  ]),
);
const lines = [
  '# Desktop command responsibility matrix',
  '',
  '> Generated by `node scripts/build-contract-manifest.mjs` from contract schema v1.',
  '',
  `Commands: ${commands.length}. Fixed renderer events: ${fixedEvents.length}. Dynamic events: 1.`,
  '',
  '## Domain summary',
  '',
  '| Domain | Wave | Commands | Resources | Dependencies |',
  '| --- | ---: | ---: | --- | --- |',
  ...Object.entries(domainDefinitions).map(
    ([domain, definition]) =>
      `| ${domain} | ${definition.wave} | ${counts[domain]} | ${definition.resources.join(', ')} | ${definition.dependencies.join(', ') || 'none'} |`,
  ),
  '',
  '## Command ownership',
  '',
  '| Command | Owner | Domain | Wave | Stateful | Mutates | Events | Source |',
  '| --- | --- | --- | ---: | --- | --- | --- | --- |',
  ...commands.map(
    (command) =>
      `| ${command.name} | ${command.currentOwner} | ${command.domain} | ${command.migrationWave} | ${command.stateful ? 'yes' : 'no'} | ${command.mutates ? 'yes' : 'no'} | ${command.emits.join(', ') || 'none'} | ${command.source} |`,
  ),
  '',
];
const manifestPath = path.join(contractDirectory, 'manifest.json');
const matrixPath = path.join(root, 'docs/migration/command-responsibility-matrix.md');
if (process.argv.includes('--check')) {
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest);
  const matrix = await readFile(matrixPath, 'utf8');
  for (const command of commands)
    assert.match(
      matrix,
      new RegExp(`\\|\\s+${command.name.replaceAll('_', '\\_')}\\s+\\|`),
      `Matrix missing ${command.name}`,
    );
} else {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(path.dirname(matrixPath), { recursive: true });
  await writeFile(matrixPath, `${lines.join('\n')}\n`);
}

console.log(
  `Mapped ${commands.length} commands across ${Object.keys(domainDefinitions).length} domains.`,
);
