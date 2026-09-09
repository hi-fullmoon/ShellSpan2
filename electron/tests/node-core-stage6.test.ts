import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import Ajv from 'ajv';
import { NodeCoreBackend } from '../node-core-backend.ts';
import valuesSchema from '../contracts/v1/command-values.schema.json';
import type { ProviderRoute } from '../node-core/llm-routes.ts';

async function backend(root: string) {
  const node = new NodeCoreBackend({
    ...process.env,
    SHELLSPAN_HOME: root,
    SHELLSPAN_APP_DATA: join(root, 'app'),
    SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
    SHELLSPAN_NODE_CORE_TEST_MODE: '1',
    SHELLSPAN_NODE_DOMAINS: 'storage,credentials,llm,agent-runtime',
  });
  await node.ready;
  return node;
}

async function value(node: NodeCoreBackend, command: string, args: object = {}) {
  const response = await node.invoke(command, args);
  if (!response.ok) throw new Error(String(response.error));
  return response.value;
}

const request = {
  sessionId: 'session-1',
  taskId: 'task-1',
  goal: 'Inspect the workspace',
  target: {
    kind: 'local',
    targetId: 'target-1',
    sessionId: 'terminal-1',
    localRoot: '',
  },
  permissionMode: 'requestApproval',
  capabilityScope: {
    toolNames: [
      'read_file',
      'list_directory',
      'search_text',
      'run_terminal_command',
      'update_plan',
    ],
    effects: ['none', 'readOnly', 'stateChange'],
    targetIds: ['target-1'],
  },
};

test('Stage 6 event store persists, projects, paginates, and archives one owned Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage6-store-'));
  let node = await backend(root);
  try {
    const created = (await value(node, 'agent_runtime_create_session', {
      request: { ...request, target: { ...request.target, localRoot: root } },
    })) as Record<string, unknown>;
    assert.equal(created.status, 'idle');
    assert.equal(created.eventCount, 2);
    assert.equal((created.header as Record<string, unknown>).createdAtUnixMs !== undefined, true);

    const queued = (await value(node, 'agent_runtime_followup', {
      input: {
        sessionId: 'session-1',
        messageId: 'message-1',
        clientSubmissionId: 'submission-1',
        content: 'Continue',
      },
    })) as { inbox: { nextTurn: unknown[] }; eventCount: number };
    assert.equal(queued.inbox.nextTurn.length, 1);
    const duplicate = (await value(node, 'agent_runtime_followup', {
      input: {
        sessionId: 'session-1',
        messageId: 'message-copy',
        clientSubmissionId: 'submission-1',
        content: 'Duplicate',
      },
    })) as { eventCount: number };
    assert.equal(duplicate.eventCount, queued.eventCount);

    const renamed = (await value(node, 'agent_runtime_rename_session', {
      input: {
        sessionId: 'session-1',
        expectedRevision: queued.eventCount,
        clientOperationId: 'rename-1',
        title: 'Workspace audit',
      },
    })) as { eventCount: number; header: { title: string } };
    assert.equal(renamed.header.title, 'Workspace audit');
    const repeated = (await value(node, 'agent_runtime_rename_session', {
      input: {
        sessionId: 'session-1',
        expectedRevision: queued.eventCount,
        clientOperationId: 'rename-1',
        title: 'Workspace audit',
      },
    })) as { eventCount: number };
    assert.equal(repeated.eventCount, renamed.eventCount);
    const stale = await node.invoke('agent_runtime_rename_session', {
      input: {
        sessionId: 'session-1',
        expectedRevision: 2,
        clientOperationId: 'rename-stale',
        title: 'Stale',
      },
    });
    assert.deepEqual(stale, { ok: false, error: 'REVISION_CONFLICT' });

    const page = (await value(node, 'agent_runtime_get_events', {
      request: { sessionId: 'session-1', cursor: 0, limit: 2 },
    })) as { events: Array<{ seq: number }>; nextCursor: number };
    assert.deepEqual(
      page.events.map((event) => event.seq),
      [0, 1],
    );
    assert.equal(page.nextCursor, 2);
    await node.stop();

    node = await backend(root);
    const restored = (await value(node, 'agent_runtime_get_session', {
      input: { sessionId: 'session-1' },
    })) as {
      eventCount: number;
      header: { title: string };
      inbox: { nextTurn: Array<{ messageId: string }> };
    };
    assert.equal(restored.header.title, 'Workspace audit');
    assert.equal(restored.inbox.nextTurn.length, 1);
    const busy = await node.invoke('agent_runtime_archive_session', {
      input: { sessionId: 'session-1' },
    });
    assert.deepEqual(busy, { ok: false, error: 'AGENT_SESSION_ARCHIVE_BUSY' });
    await value(node, 'agent_runtime_mutate_inbox', {
      input: {
        sessionId: 'session-1',
        expectedRevision: restored.eventCount,
        clientOperationId: 'remove-before-archive',
        mutation: { type: 'remove', itemId: restored.inbox.nextTurn[0].messageId },
      },
    });
    const archived = (await value(node, 'agent_runtime_archive_session', {
      input: { sessionId: 'session-1' },
    })) as { archived: boolean; ended: boolean; status: string };
    assert.equal(archived.archived, true);
    assert.deepEqual(
      { ended: archived.ended, status: archived.status },
      { ended: true, status: 'completed' },
    );
    const immutable = await node.invoke('agent_runtime_followup', {
      input: { sessionId: 'session-1', messageId: 'm2', content: 'No' },
    });
    assert.deepEqual(immutable, { ok: false, error: 'archived Agent Session logs are read-only' });
  } finally {
    await node.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Stage 6 restart discards only a malformed tail and retains explicit recovery evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage6-recovery-'));
  let node = await backend(root);
  try {
    await value(node, 'agent_runtime_create_session', {
      request: { ...request, target: { ...request.target, localRoot: root } },
    });
    await node.stop();
    await appendFile(
      join(root, 'app', 'agent-runtime', 'sessions-v5', 'session-1.jsonl'),
      '{"broken":',
    );
    node = await backend(root);
    const listed = (await value(node, 'agent_runtime_list_sessions', {
      request: { limit: 10 },
    })) as {
      sessions: unknown[];
      recoveryNotices: Array<{ action: string; evidenceFileName: string }>;
    };
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.recoveryNotices[0].action, 'badTailDiscarded');
    assert.match(listed.recoveryNotices[0].evidenceFileName, /recovery-/);
  } finally {
    await node.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Stage 6 images, file references, skills and artifacts remain target-bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage6-references-'));
  const node = await backend(root);
  try {
    await mkdir(join(root, '.agents', 'skills', 'audit'), { recursive: true });
    await writeFile(
      join(root, '.agents', 'skills', 'audit', 'SKILL.md'),
      '---\nname: audit\ndescription: Inspect safely\n---\nInstructions.\n',
    );
    await writeFile(join(root, 'needle.txt'), 'workspace needle');
    await value(node, 'agent_runtime_create_session', {
      request: { ...request, target: { ...request.target, localRoot: root } },
    });
    const files = (await value(node, 'agent_runtime_list_file_references', {
      input: { sessionId: 'session-1', requestId: 'files-1', query: 'needle' },
    })) as { status: string; entries: Array<{ path: string }> };
    assert.equal(files.status, 'ready');
    assert.deepEqual(
      files.entries.map((entry) => entry.path),
      ['needle.txt'],
    );
    const skills = (await value(node, 'agent_runtime_list_skills', {
      input: { sessionId: 'session-1' },
    })) as { entries: Array<{ name: string }>; revision: string };
    assert.equal(skills.entries[0].name, 'audit');
    assert.match(skills.revision, /^[a-f0-9]{64}$/);

    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const prepared = (await value(node, 'agent_runtime_prepare_images', {
      images: [{ data: png, mediaType: 'image/png', name: 'pixel.png' }],
    })) as Array<{ data: string }>;
    assert.equal(prepared.length, 1);
    const submitted = (await value(node, 'agent_runtime_submit_images', {
      input: {
        sessionId: 'session-1',
        clientOperationId: 'image-1',
        content: 'pixel',
        images: [{ data: png, mediaType: 'image/png', name: 'pixel.png' }],
        lane: 'nextTurn',
      },
    })) as { inbox: { nextTurn: Array<{ images: Array<{ sha256: string }> }> } };
    const sha256 = submitted.inbox.nextTurn[0].images[0].sha256;
    const preview = await value(node, 'agent_runtime_image_preview', {
      input: { sessionId: 'session-1', sha256 },
    });
    assert.match(String(preview), /^data:image\/png;base64,/);
  } finally {
    await node.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Stage 6 subagent and Fleet coordination stay inside the parent target scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage6-subagent-'));
  const node = await backend(root);
  try {
    await value(node, 'agent_runtime_create_session', {
      request: { ...request, target: { ...request.target, localRoot: root } },
    });
    const routes = (await value(node, 'ai_list_routes')) as { revision: number };
    const route: ProviderRoute = {
      id: 'local',
      revision: 0,
      displayName: 'Local',
      adapterId: 'ollama',
      baseUrl: 'http://127.0.0.1:1',
      auth: { kind: 'none' },
      replayDomainId: 'client',
      presetId: 'ollama',
      defaults: { routeId: 'local', modelId: 'qwen3:8b' },
      retryPolicy: {
        maxAttempts: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        maxServerDelayMs: 1,
        jitterRatio: 0,
      },
      timeouts: { requestHeadersMs: 100, firstByteMs: 100, streamIdleMs: 100 },
    };
    await value(node, 'ai_save_routes', {
      input: {
        routes: [route],
        defaultSelection: route.defaults,
        expectedRevision: routes.revision,
      },
    });
    await value(node, 'agent_runtime_select_model', {
      input: { sessionId: 'session-1', selection: route.defaults },
    });
    const parent = (await value(node, 'agent_runtime_spawn_subagent', {
      request: {
        parentSessionId: 'session-1',
        goal: 'Inspect one file',
        role: 'explorer',
        inheritanceMode: 'safePrefix',
        targetIds: ['target-1'],
        continuable: true,
      },
    })) as { eventCount: number };
    assert.ok(parent.eventCount > 2);
    const events = (await value(node, 'agent_runtime_get_events', {
      request: { sessionId: 'session-1', limit: 100 },
    })) as { events: Array<{ type: string; data?: { childSessionId?: string } }> };
    const child = events.events.find((event) => event.type === 'subagent/descriptor')?.data
      ?.childSessionId;
    assert.ok(child);
    const inspection = (await value(node, 'agent_runtime_inspect_child_agent', {
      request: { parentSessionId: 'session-1', childSessionId: child },
    })) as { snapshot: { header: { parentSessionId: string } } };
    assert.equal(inspection.snapshot.header.parentSessionId, 'session-1');
    const escaped = await node.invoke('agent_runtime_spawn_subagent', {
      request: {
        parentSessionId: 'session-1',
        goal: 'Escape',
        role: 'explorer',
        inheritanceMode: 'blank',
        targetIds: ['other'],
      },
    });
    assert.equal(escaped.ok, false);

    const fleet = (await value(node, 'agent_runtime_fleet_plan', {
      request: {
        parentSessionId: 'session-1',
        targets: [{ targetId: 'target-1', goal: 'Check' }],
        canarySize: 1,
        waveSize: 1,
        failureThreshold: 0,
      },
    })) as { fleet: { fleetId: string; status: string } };
    assert.equal(fleet.fleet.status, 'planned');
    const paused = (await value(node, 'agent_runtime_fleet_pause', {
      request: { parentSessionId: 'session-1', fleetId: fleet.fleet.fleetId },
    })) as { fleet: { status: string } };
    assert.equal(paused.fleet.status, 'paused');
    const started = (await value(node, 'agent_runtime_fleet_start', {
      request: { parentSessionId: 'session-1', fleetId: fleet.fleet.fleetId },
    })) as {
      fleet: { status: string; targets: Array<{ state: string; childSessionIds: string[] }> };
    };
    assert.equal(started.fleet.status, 'running');
    assert.equal(started.fleet.targets[0].state, 'running');
    assert.equal(started.fleet.targets[0].childSessionIds.length, 1);
  } finally {
    await node.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Stage 6 snapshots and event pages satisfy the frozen command value schemas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage6-schema-'));
  const node = await backend(root);
  try {
    const snapshot = await value(node, 'agent_runtime_create_session', {
      request: { ...request, target: { ...request.target, localRoot: root } },
    });
    const page = await value(node, 'agent_runtime_get_events', {
      request: { sessionId: 'session-1', limit: 100 },
    });
    const ajv = new Ajv({ strict: false, allErrors: true });
    const definitions = valuesSchema.definitions;
    const schemas = definitions.CommandValues.properties as Record<string, object>;
    for (const [command, result] of [
      ['agent_runtime_create_session', snapshot],
      ['agent_runtime_get_events', page],
    ] as const) {
      const validate = ajv.compile({ ...schemas[command], definitions });
      assert.equal(validate(result), true, JSON.stringify(validate.errors));
    }
  } finally {
    await node.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Stage 6 drives a recorded-style provider turn through durable v5 events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage6-turn-'));
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/x-ndjson');
    response.write(
      `${JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content: 'Done.' }, done: false })}\n`,
    );
    response.end(
      `${JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 8, eval_count: 2 })}\n`,
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const node = await backend(root);
  try {
    await value(node, 'agent_runtime_create_session', {
      request: { ...request, target: { ...request.target, localRoot: root } },
    });
    const routes = (await value(node, 'ai_list_routes')) as { revision: number };
    const route: ProviderRoute = {
      id: 'turn-route',
      revision: 0,
      displayName: 'Turn fixture',
      adapterId: 'ollama',
      baseUrl: `http://127.0.0.1:${address.port}`,
      auth: { kind: 'none' },
      replayDomainId: 'client',
      presetId: 'ollama',
      defaults: { routeId: 'turn-route', modelId: 'qwen3:8b' },
      retryPolicy: {
        maxAttempts: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        maxServerDelayMs: 1,
        jitterRatio: 0,
      },
      timeouts: { requestHeadersMs: 1_000, firstByteMs: 1_000, streamIdleMs: 1_000 },
    };
    await value(node, 'ai_save_routes', {
      input: {
        routes: [route],
        defaultSelection: route.defaults,
        expectedRevision: routes.revision,
      },
    });
    await value(node, 'agent_runtime_start', {
      input: { sessionId: 'session-1', selection: route.defaults },
    });
    let snapshot = {} as { ended?: boolean; status?: string };
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = (await value(node, 'agent_runtime_get_session', {
        input: { sessionId: 'session-1' },
      })) as typeof snapshot;
      if (snapshot.ended) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.deepEqual(
      { ended: snapshot.ended, status: snapshot.status },
      { ended: true, status: 'completed' },
    );
    const page = (await value(node, 'agent_runtime_get_events', {
      request: { sessionId: 'session-1', limit: 100 },
    })) as { events: Array<{ type: string }> };
    assert.ok(page.events.some((event) => event.type === 'request/header'));
    assert.ok(page.events.some((event) => event.type === 'assistant/message'));
    assert.ok(page.events.some((event) => event.type === 'request/usage'));
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile({
      $ref: '#/definitions/AgentSessionEvent',
      definitions: valuesSchema.definitions,
    });
    for (const event of page.events)
      assert.equal(validate(event), true, `${event.type}: ${JSON.stringify(validate.errors)}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await node.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Stage 6 binds approval identity immediately before one side effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage6-approval-'));
  let providerRequests = 0;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/x-ndjson');
    providerRequests++;
    if (providerRequests > 1) {
      response.end(
        `${JSON.stringify({
          model: 'qwen3:8b',
          message: { role: 'assistant', content: 'Tool result received.' },
          done: true,
          done_reason: 'stop',
        })}\n`,
      );
      return;
    }
    response.end(
      `${JSON.stringify({
        model: 'qwen3:8b',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              function: {
                name: 'run_terminal_command',
                arguments: { command: 'echo TOOL_OK', explanation: 'approval fixture' },
              },
            },
          ],
        },
        done: true,
        done_reason: 'stop',
      })}\n`,
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const node = await backend(root);
  try {
    await value(node, 'agent_runtime_create_session', {
      request: { ...request, target: { ...request.target, localRoot: root } },
    });
    const routes = (await value(node, 'ai_list_routes')) as { revision: number };
    const route: ProviderRoute = {
      id: 'approval-route',
      revision: 0,
      displayName: 'Approval fixture',
      adapterId: 'ollama',
      baseUrl: `http://127.0.0.1:${address.port}`,
      auth: { kind: 'none' },
      replayDomainId: 'client',
      presetId: 'ollama',
      defaults: { routeId: 'approval-route', modelId: 'qwen3:8b' },
      retryPolicy: {
        maxAttempts: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        maxServerDelayMs: 1,
        jitterRatio: 0,
      },
      timeouts: { requestHeadersMs: 1_000, firstByteMs: 1_000, streamIdleMs: 1_000 },
    };
    await value(node, 'ai_save_routes', {
      input: {
        routes: [route],
        defaultSelection: route.defaults,
        expectedRevision: routes.revision,
      },
    });
    await value(node, 'agent_runtime_start', {
      input: { sessionId: 'session-1', selection: route.defaults },
    });

    type WireEvent = {
      type: string;
      turnId?: string;
      stepId?: string;
      data?: Record<string, unknown>;
    };
    let events: WireEvent[] = [];
    let approval: WireEvent | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      events = (
        (await value(node, 'agent_runtime_get_events', {
          request: { sessionId: 'session-1', limit: 100 },
        })) as { events: WireEvent[] }
      ).events;
      approval = events.find(
        (event) => event.type === 'tool/approval' && event.data?.status === 'requested',
      );
      if (approval) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.ok(approval?.data);
    const mismatch = await node.invoke('agent_runtime_approve_tool', {
      input: {
        sessionId: 'session-1',
        turnId: approval.turnId,
        stepId: approval.stepId,
        requestId: approval.data.requestId,
        callId: 'wrong-call',
        approvalId: approval.data.approvalId,
      },
    });
    assert.equal(mismatch.ok, false);
    await value(node, 'agent_runtime_approve_tool', {
      input: {
        sessionId: 'session-1',
        turnId: approval.turnId,
        stepId: approval.stepId,
        requestId: approval.data.requestId,
        callId: approval.data.callId,
        approvalId: approval.data.approvalId,
      },
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      events = (
        (await value(node, 'agent_runtime_get_events', {
          request: { sessionId: 'session-1', limit: 100 },
        })) as { events: WireEvent[] }
      ).events;
      if (events.some((event) => event.type === 'session/ended')) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    const result = events.find((event) => event.type === 'tool/result');
    assert.equal(result?.data?.status, 'completed');
    assert.equal(
      events.some((event) => event.type === 'session/ended'),
      true,
    );
    assert.equal(events.filter((event) => event.type === 'request/header').length, 2);
    assert.equal(
      events.filter((event) => event.type === 'tool/execution' && event.data?.callId === 'call-1')
        .length,
      1,
    );
  } finally {
    server.closeAllConnections();
    server.close();
    await node.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Stage 6 validates durable user questions and continues the same Turn after answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage6-question-'));
  let providerRequests = 0;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/x-ndjson');
    providerRequests++;
    response.end(
      `${JSON.stringify(
        providerRequests === 1
          ? {
              model: 'qwen3:8b',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'question-call',
                    function: {
                      name: 'ask_user_question',
                      arguments: {
                        questions: [
                          {
                            id: 'choice',
                            question: 'Which path?',
                            options: [{ label: 'Safe (Recommended)' }, { label: 'Fast' }],
                          },
                        ],
                      },
                    },
                  },
                ],
              },
              done: true,
              done_reason: 'stop',
            }
          : {
              model: 'qwen3:8b',
              message: { role: 'assistant', content: 'Choice received.' },
              done: true,
              done_reason: 'stop',
            },
      )}\n`,
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const node = await backend(root);
  try {
    await value(node, 'agent_runtime_create_session', {
      request: { ...request, target: { ...request.target, localRoot: root } },
    });
    const routes = (await value(node, 'ai_list_routes')) as { revision: number };
    const route: ProviderRoute = {
      id: 'question-route',
      revision: 0,
      displayName: 'Question fixture',
      adapterId: 'ollama',
      baseUrl: `http://127.0.0.1:${address.port}`,
      auth: { kind: 'none' },
      replayDomainId: 'client',
      presetId: 'ollama',
      defaults: { routeId: 'question-route', modelId: 'qwen3:8b' },
      retryPolicy: {
        maxAttempts: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        maxServerDelayMs: 1,
        jitterRatio: 0,
      },
      timeouts: { requestHeadersMs: 1_000, firstByteMs: 1_000, streamIdleMs: 1_000 },
    };
    await value(node, 'ai_save_routes', {
      input: {
        routes: [route],
        defaultSelection: route.defaults,
        expectedRevision: routes.revision,
      },
    });
    await value(node, 'agent_runtime_start', {
      input: { sessionId: 'session-1', selection: route.defaults },
    });
    type WireEvent = {
      type: string;
      turnId?: string;
      stepId?: string;
      data?: Record<string, unknown>;
    };
    let events: WireEvent[] = [];
    let requested: WireEvent | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      events = (
        (await value(node, 'agent_runtime_get_events', {
          request: { sessionId: 'session-1', limit: 100 },
        })) as { events: WireEvent[] }
      ).events;
      requested = events.find((event) => event.type === 'question/requested');
      if (requested) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    const identity = requested?.data?.identity as Record<string, unknown> | undefined;
    assert.ok(identity);
    const mismatch = await node.invoke('agent_runtime_answer_question', {
      input: {
        identity: { ...identity, callId: 'wrong-call' },
        clientOperationId: 'answer-bad',
        answers: [{ id: 'choice', selected: ['Safe (Recommended)'] }],
      },
    });
    assert.equal(mismatch.ok, false);
    await value(node, 'agent_runtime_answer_question', {
      input: {
        identity,
        clientOperationId: 'answer-1',
        answers: [{ id: 'choice', selected: ['Safe (Recommended)'] }],
      },
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      events = (
        (await value(node, 'agent_runtime_get_events', {
          request: { sessionId: 'session-1', limit: 100 },
        })) as { events: WireEvent[] }
      ).events;
      if (events.some((event) => event.type === 'session/ended')) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(
      events.some((event) => event.type === 'question/answered'),
      true,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === 'tool/result' &&
          event.data?.name === 'ask_user_question' &&
          event.data?.status === 'completed',
      ),
      true,
    );
    assert.equal(events.filter((event) => event.type === 'request/header').length, 2);
    assert.equal(
      events.some((event) => event.type === 'session/ended'),
      true,
    );
  } finally {
    server.closeAllConnections();
    server.close();
    await node.stop();
    await rm(root, { recursive: true, force: true });
  }
});
