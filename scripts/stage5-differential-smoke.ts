import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as assert from 'node:assert/strict';
import type { NodeCoreBackend as NodeCoreBackendType } from '../electron/node-core-backend.ts';
import type { RustCoreBackend as RustCoreBackendType } from '../electron/rust-core-backend.ts';
import type { replayProviderRecording as replayType } from '../electron/node-core/llm-runtime.ts';

const require = createRequire(import.meta.url);
const { NodeCoreBackend } = require('../dist-electron/node-core-backend.js') as {
  NodeCoreBackend: typeof NodeCoreBackendType;
};
const { RustCoreBackend } = require('../dist-electron/rust-core-backend.js') as {
  RustCoreBackend: typeof RustCoreBackendType;
};
const { replayProviderRecording } = require('../dist-electron/node-core/llm-runtime.js') as {
  replayProviderRecording: typeof replayType;
};

const executable = process.platform === 'win32' ? 'shellspan-core.exe' : 'shellspan-core';
const temporary = await mkdtemp(join(tmpdir(), 'shellspan-stage5-diff-'));
const rustRoot = join(temporary, 'rust');
const nodeRoot = join(temporary, 'node');
await Promise.all([mkdir(rustRoot), mkdir(nodeRoot)]);
const environment = (home: string) => ({
  ...process.env,
  SHELLSPAN_HOME: home,
  SHELLSPAN_APP_DATA: join(home, 'app'),
  SHELLSPAN_LOG_DIR: join(home, 'logs'),
  SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
  SHELLSPAN_NODE_DOMAINS: 'storage,credentials,llm',
});
const rust = new RustCoreBackend(resolve('native/target/debug', executable), environment(rustRoot));
const node = new NodeCoreBackend(
  environment(nodeRoot),
  resolve('dist-electron/node-core/entry.js'),
);

function normalize(value: unknown, root: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, root));
  if (!value || typeof value !== 'object')
    return typeof value === 'string'
      ? value.replaceAll(root, '<ROOT>').replaceAll('\\', '/')
      : value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      key === 'replayDomainId'
        ? '<REPLAY_DOMAIN>'
        : key === 'reference' && typeof entry === 'string' && entry.startsWith('llm-')
          ? '<CREDENTIAL_REFERENCE>'
          : normalize(entry, root),
    ]),
  );
}

async function both(command: string, args: object = {}) {
  const [rustResult, nodeResult] = await Promise.all([
    rust.invoke(command, args),
    node.invoke(command, args),
  ]);
  assert.deepEqual(normalize(rustResult, rustRoot), normalize(nodeResult, nodeRoot), command);
  return nodeResult;
}

const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end('{"data":[{"id":"z-model"},{"id":"a-model"},{"id":"a-model"}]}');
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address === 'object');

try {
  await Promise.all([rust.ready, node.ready]);
  await both('ai_list_routes');
  const resolvedFixtures = JSON.parse(
    await readFile('protocol/llm/fixtures/resolved-models.json', 'utf8'),
  ) as Array<{ provider: object }>;
  for (const fixture of resolvedFixtures) await both('ai_resolve_model', fixture);
  await both('ai_model_declaration_template', {
    provider: {
      id: 'template',
      profile: 'openai',
      kind: 'openAi',
      baseUrl: 'https://api.openai.com',
      model: 'future-model',
      requiresApiKey: false,
    },
  });
  const route = {
    id: 'openai-route',
    revision: 0,
    displayName: 'OpenAI fixture',
    adapterId: 'responses',
    baseUrl: 'https://api.openai.com',
    auth: { kind: 'none' },
    replayDomainId: 'client-placeholder',
    presetId: 'openai',
    defaults: { routeId: 'openai-route', modelId: 'gpt-5' },
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 250,
      maxDelayMs: 4000,
      maxServerDelayMs: 30000,
      jitterRatio: 0.2,
    },
    timeouts: { requestHeadersMs: 30000, firstByteMs: 30000, streamIdleMs: 300000 },
  };
  await both('ai_save_routes', {
    input: {
      routes: [route],
      defaultSelection: route.defaults,
      expectedRevision: 1,
    },
  });
  await both('ai_list_route_models', { routeId: route.id });
  await both('ai_resolve_selection', {
    input: { selection: route.defaults, expectedRevision: 1 },
  });
  const provider = {
    id: 'discovery',
    profile: 'generic',
    kind: 'openAiCompatible',
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: 'unused',
    requiresApiKey: false,
  };
  await both('ai_list_models', { provider });

  const migrationEvents = [
    {
      version: 4,
      sessionId: 'fixture',
      seq: 0,
      timeUnixMs: 1,
      type: 'session/created',
      data: { taskId: 'task', goal: 'goal' },
    },
    {
      version: 4,
      sessionId: 'fixture',
      seq: 1,
      timeUnixMs: 1,
      type: 'agent/created',
      data: { agentId: 'fixture' },
    },
  ];
  for (const root of [rustRoot, nodeRoot]) {
    const directory = join(root, 'app', 'agent-runtime', 'sessions-v4');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'fixture.jsonl'),
      `${migrationEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
  }
  await both('ai_list_session_migrations');
  await both('ai_convert_session_v4_to_v5', { input: { sessionId: 'fixture' } });
  assert.deepEqual(
    JSON.parse(
      (await readFile(join(rustRoot, 'app/agent-runtime/sessions-v5/fixture.jsonl'), 'utf8'))
        .trim()
        .split('\n')[0],
    ),
    JSON.parse(
      (await readFile(join(nodeRoot, 'app/agent-runtime/sessions-v5/fixture.jsonl'), 'utf8'))
        .trim()
        .split('\n')[0],
    ),
  );

  const recordings = JSON.parse(
    await readFile('electron/tests/fixtures/llm-recordings.json', 'utf8'),
  ) as Array<{
    name: string;
    recording: Parameters<typeof replayProviderRecording>[0];
    expectedDeltas: unknown[];
  }>;
  for (const fixture of recordings) {
    const deltas: unknown[] = [];
    replayProviderRecording(fixture.recording, (delta) => deltas.push(delta));
    assert.deepEqual(deltas, fixture.expectedDeltas, fixture.name);
  }
  console.log(
    'Stage 5 Rust/Node commands, session conversion, catalog and recorded normalized streams matched.',
  );
} finally {
  server.closeAllConnections();
  server.close();
  await Promise.all([rust.stop(), node.stop()]);
  await rm(temporary, { recursive: true, force: true });
}
