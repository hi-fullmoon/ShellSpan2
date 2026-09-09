import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NodeCoreBackend } from '../node-core-backend.ts';
import { resolveModel } from '../node-core/llm-catalog.ts';
import { LlmImageStore, validateUploadEnvelope } from '../node-core/llm-images.ts';
import { convertV4ToV5 } from '../node-core/llm-migration.ts';
import {
  NormalizedModelError,
  normalizeProviderError,
  providerUsageFromValue,
  prepareProviderBody,
  prepareRequestSnapshot,
  replayProviderRecording,
  retryPlan,
  streamProvider,
  type ProviderRecording,
  type StreamDelta,
} from '../node-core/llm-runtime.ts';
import type { ProviderRoute } from '../node-core/llm-routes.ts';

async function backend(root: string) {
  const node = new NodeCoreBackend({
    ...process.env,
    SHELLSPAN_HOME: root,
    SHELLSPAN_APP_DATA: join(root, 'app'),
    SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
    SHELLSPAN_NODE_DOMAINS: 'storage,credentials,llm',
  });
  await node.ready;
  return node;
}

async function value(node: NodeCoreBackend, command: string, args: object = {}) {
  const response = await node.invoke(command, args);
  if (!response.ok) throw new Error(String(response.error));
  return response.value;
}

test('all frozen Rust resolved-model fixtures match Node exactly', () => {
  const fixtures = JSON.parse(
    require('node:fs').readFileSync(
      resolve(process.cwd(), 'protocol/llm/fixtures/resolved-models.json'),
      'utf8',
    ),
  ) as Array<{ provider: Parameters<typeof resolveModel>[0]; resolved: unknown }>;
  assert.equal(fixtures.length, 54);
  for (const fixture of fixtures)
    assert.deepEqual(resolveModel(fixture.provider), fixture.resolved);
});

test('recorded provider streams replay to the Rust-normalized delta sequence', () => {
  const fixtures = JSON.parse(
    require('node:fs').readFileSync(
      resolve(process.cwd(), 'electron/tests/fixtures/llm-recordings.json'),
      'utf8',
    ),
  ) as Array<{
    name: string;
    recording: ProviderRecording;
    expectedDeltas: StreamDelta[];
    expected: Record<string, unknown>;
  }>;
  for (const fixture of fixtures) {
    const deltas: StreamDelta[] = [];
    const result = replayProviderRecording(fixture.recording, (delta) => deltas.push(delta));
    assert.deepEqual(deltas, fixture.expectedDeltas, fixture.name);
    assert.deepEqual(
      {
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
      },
      fixture.expected,
      fixture.name,
    );
    assert.deepEqual(result.replay.recording, fixture.recording);
  }
});

test('prepared requests bind immutable route facts without credentials or image payloads', () => {
  const provider = {
    id: 'openai-route',
    profile: 'openai',
    kind: 'openAi' as const,
    baseUrl: 'https://api.openai.com',
    model: 'gpt-5',
    reasoningEffort: 'high',
    requiresApiKey: true,
    apiKey: 'must-never-enter-the-snapshot',
  };
  const route: ProviderRoute = {
    id: provider.id,
    revision: 7,
    displayName: 'OpenAI',
    adapterId: 'responses',
    baseUrl: provider.baseUrl,
    auth: { kind: 'keychain', reference: 'llm-reference' },
    replayDomainId: 'replay-domain',
    presetId: 'openai',
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 250,
      maxDelayMs: 4000,
      maxServerDelayMs: 30000,
      jitterRatio: 0.2,
    },
    timeouts: { requestHeadersMs: 30000, firstByteMs: 30000, streamIdleMs: 300000 },
  };
  const prepared = prepareRequestSnapshot(
    provider,
    route,
    {
      requestId: 'attempt-only-id',
      messages: [
        { role: 'userImages', content: 'inspect', dataUrls: ['data:image/png;base64,secret'] },
      ],
    },
    'step',
  );
  const encoded = JSON.stringify(prepared);
  assert.doesNotMatch(encoded, /must-never|data:image|attempt-only-id/);
  assert.equal(prepared.snapshot.routeRevision, 7);
  assert.match(prepared.digest, /^[a-f0-9]{64}$/);
  const body = prepareProviderBody(provider, { model: 'gpt-5' });
  assert.equal(body.max_output_tokens, 4096);
  assert.deepEqual(body.reasoning, { effort: 'high' });
});

test('route CAS, model resolution and secret versioning are atomic and secret-free', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage5-routes-'));
  const node = await backend(root);
  try {
    const initial = (await value(node, 'ai_list_routes')) as {
      revision: number;
      routes: unknown[];
    };
    assert.deepEqual(initial, {
      schemaVersion: 1,
      revision: 1,
      routes: [],
      defaultSelection: null,
      migrationComplete: true,
      migrationIssues: [],
    });
    const route: ProviderRoute = {
      id: 'openai-route',
      revision: 0,
      displayName: 'OpenAI fixture',
      adapterId: 'responses',
      baseUrl: 'https://api.openai.com',
      auth: { kind: 'keychain', reference: 'client-cannot-select-this' },
      replayDomainId: 'client-cannot-select-this',
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
    const saved = (await value(node, 'ai_save_routes', {
      input: {
        routes: [route],
        defaultSelection: route.defaults,
        expectedRevision: initial.revision,
        secrets: { 'openai-route': 'stage-five-super-secret' },
      },
    })) as { revision: number; routes: ProviderRoute[] };
    assert.equal(saved.revision, 2);
    assert.equal(saved.routes[0].revision, 1);
    assert.match(
      saved.routes[0].auth.kind === 'keychain' ? saved.routes[0].auth.reference : '',
      /^llm-/,
    );
    assert.notEqual(saved.routes[0].replayDomainId, route.replayDomainId);
    assert.doesNotMatch(JSON.stringify(saved), /stage-five-super-secret/);
    assert.doesNotMatch(
      (await readFile(join(root, '.shellspan-dev', 'shellspan.db'))).toString('latin1'),
      /stage-five-super-secret/,
    );

    const routeModels = (await value(node, 'ai_list_route_models', {
      routeId: 'openai-route',
    })) as { revision: number; models: Array<{ modelId: string }> };
    assert.equal(routeModels.revision, 2);
    assert.ok(routeModels.models.some((model) => model.modelId === 'gpt-5'));
    assert.equal(
      (
        (await value(node, 'ai_resolve_selection', {
          input: {
            selection: { routeId: 'openai-route', modelId: 'gpt-5' },
            expectedRevision: 1,
          },
        })) as { modelId: string }
      ).modelId,
      'gpt-5',
    );
    const stale = await node.invoke('ai_save_routes', {
      input: { routes: [route], expectedRevision: 1 },
    });
    assert.deepEqual(stale, { ok: false, error: 'REVISION_CONFLICT' });
  } finally {
    await node.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('model discovery uses stable credentials without persisting an ephemeral key', async () => {
  let request = '';
  const server = createServer((incoming, response) => {
    request = `${incoming.method} ${incoming.url}\n${JSON.stringify(incoming.headers)}`;
    response.setHeader('content-type', 'application/json');
    response.end('{"data":[{"id":"z-model"},{"id":"a-model"},{"id":"a-model"}]}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage5-discovery-'));
  const node = await backend(root);
  try {
    assert.deepEqual(
      await value(node, 'ai_list_models', {
        provider: {
          id: 'draft',
          profile: 'generic',
          kind: 'openAiCompatible',
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: 'draft-model',
          modelDefinition: {
            contextWindow: 8192,
            maxOutputTokens: 2048,
            toolCalling: 'supported',
            textInput: 'supported',
            imageInput: 'unsupported',
            reasoning: [],
            compat: {
              protocol: 'openAiCompatible',
              cumulativeStream: false,
              supportsStreamUsage: true,
              nativeReasoning: false,
              splitReasoning: false,
              replayReasoningContent: false,
              thinkTagFallback: false,
              parallelToolCalls: true,
              strictSchema: true,
              preservesReasoningAcrossTurns: false,
              reasoningEncoding: 'none',
              clearThinking: false,
              defaultThinking: false,
            },
          },
          requiresApiKey: true,
          apiKey: 'ephemeral-discovery-key',
        },
      }),
      ['a-model', 'z-model'],
    );
    assert.match(request, /^GET \/v1\/models/);
    assert.match(request.toLowerCase(), /bearer ephemeral-discovery-key/);
    assert.doesNotMatch(
      (await readFile(join(root, '.shellspan-dev', 'shellspan.db'))).toString('latin1'),
      /ephemeral-discovery-key/,
    );
  } finally {
    await node.stop();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('stream retry, usage, error classification and cancellation obey bounded policy', async () => {
  let attempts = 0;
  let serverFinished = false;
  let deltaBeforeFinish = false;
  const server = createServer((_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.statusCode = 503;
      response.setHeader('retry-after-ms', '1');
      response.end('temporary');
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    response.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
    setTimeout(() => {
      serverFinished = true;
      response.end(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n' +
          'data: [DONE]\n\n',
      );
    }, 20);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await streamProvider({
      provider: {
        id: 'retry-fixture',
        profile: 'generic',
        kind: 'openAiCompatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: 'fixture',
        modelDefinition: {
          contextWindow: 8192,
          maxOutputTokens: 2048,
          toolCalling: 'supported',
          textInput: 'supported',
          imageInput: 'unsupported',
          reasoning: [],
          compat: {
            protocol: 'openAiCompatible',
            cumulativeStream: false,
            supportsStreamUsage: true,
            nativeReasoning: false,
            splitReasoning: false,
            replayReasoningContent: false,
            thinkTagFallback: false,
            parallelToolCalls: true,
            strictSchema: true,
            preservesReasoningAcrossTurns: false,
            reasoningEncoding: 'none',
            clearThinking: false,
            defaultThinking: false,
          },
        },
        requiresApiKey: false,
      },
      body: { stream: true },
      random: () => 0.5,
      retryPolicy: {
        maxAttempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        maxServerDelayMs: 10,
        jitterRatio: 0,
      },
      emit: (delta) => {
        if (delta.type === 'text' && !serverFinished) deltaBeforeFinish = true;
      },
    });
    assert.equal(attempts, 2);
    assert.equal(deltaBeforeFinish, true);
    assert.deepEqual(response.usage, {
      uncachedInputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    });
    assert.equal(normalizeProviderError(401, 'bad key').kind, 'authentication');
    assert.equal(normalizeProviderError(429, 'slow down').kind, 'rateLimited');
    assert.equal(normalizeProviderError(400, 'maximum context exceeded').kind, 'contextTooLarge');
    const secretError = normalizeProviderError(500, 'Authorization: Bearer sk-stage-five-secret');
    assert.doesNotMatch(secretError.message, /sk-stage-five-secret/);
    assert.deepEqual(
      retryPlan(
        {
          maxAttempts: 3,
          initialDelayMs: 100,
          maxDelayMs: 250,
          maxServerDelayMs: 2000,
          jitterRatio: 0.2,
        },
        new NormalizedModelError('transport', 'connection failed'),
        1,
        0,
      )?.delayMs,
      80,
    );
    assert.deepEqual(
      providerUsageFromValue('anthropicMessages', {
        usage: {
          input_tokens: 11,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
          output_tokens: 4,
        },
      }),
      {
        uncachedInputTokens: 11,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        outputTokens: 4,
        totalTokens: 23,
      },
    );
  } finally {
    server.close();
  }

  const idle = createServer((_request, response) => {
    response.setHeader('content-type', 'text/event-stream');
    response.flushHeaders();
  });
  await new Promise<void>((resolve) => idle.listen(0, '127.0.0.1', resolve));
  const idleAddress = idle.address();
  assert.ok(idleAddress && typeof idleAddress === 'object');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(
      streamProvider({
        provider: {
          id: 'cancel-fixture',
          profile: 'ollama',
          kind: 'ollama',
          baseUrl: `http://127.0.0.1:${idleAddress.port}`,
          model: 'qwen3',
          requiresApiKey: false,
        },
        body: { stream: true },
        signal: controller.signal,
        retryPolicy: {
          maxAttempts: 1,
          initialDelayMs: 0,
          maxDelayMs: 0,
          maxServerDelayMs: 0,
          jitterRatio: 0,
        },
        timeouts: { requestHeadersMs: 1000, firstByteMs: 1000, streamIdleMs: 1000 },
      }),
      (error: unknown) => error instanceof NormalizedModelError && error.kind === 'cancelled',
    );
  } finally {
    idle.closeAllConnections();
    idle.close();
  }
});

test('v4 conversion is idempotent, preserves source and backup, and reports failed markers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage5-migration-'));
  const source = join(root, 'agent-runtime', 'sessions-v4', 'fixture.jsonl');
  const destination = join(root, 'agent-runtime', 'sessions-v5', 'fixture.jsonl');
  await require('node:fs/promises').mkdir(join(root, 'agent-runtime', 'sessions-v4'), {
    recursive: true,
  });
  const events = [
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
  await writeFile(source, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const sourceBefore = await readFile(source);
  try {
    const converted = await convertV4ToV5(source, destination);
    assert.equal(converted.status, 'converted');
    assert.equal(converted.events, 2);
    assert.deepEqual(await readFile(source), sourceBefore);
    assert.deepEqual(
      await readFile(join(root, 'agent-runtime', 'sessions-v5', 'fixture.v4.backup.jsonl')),
      sourceBefore,
    );
    const destinationBefore = await readFile(destination);
    assert.equal((await convertV4ToV5(source, destination)).status, 'alreadyConverted');
    assert.deepEqual(await readFile(destination), destinationBefore);
    await assert.rejects(
      stat(join(root, 'agent-runtime', 'sessions-v4', 'fixture.migration.lock')),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('image preparation normalizes, verifies, previews and enforces batch boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage5-images-'));
  const store = new LlmImageStore(root);
  await store.initialize();
  const pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  try {
    const references = await store.import([
      { mediaType: 'image/png', data: pixel, name: '../credential-token.png' },
    ]);
    assert.equal(references[0].width, 1);
    assert.equal(references[0].height, 1);
    assert.equal(references[0].mediaType, 'image/png');
    assert.equal(references[0].name, 'credential-token.png');
    assert.match(await store.preview(references[0]), /^data:image\/png;base64,/);
    assert.throws(
      () =>
        validateUploadEnvelope(
          Array.from({ length: 21 }, () => ({
            mediaType: 'image/png',
            data: pixel,
            name: 'x.png',
          })),
        ),
      /IMAGE_COUNT_LIMIT/,
    );
    await writeFile(join(store.root, references[0].sha256), Buffer.from('tampered'));
    await assert.rejects(store.read(references[0]), /IMAGE_BLOB_TAMPERED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
