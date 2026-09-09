import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as assert from 'node:assert/strict';
import type { NodeCoreBackend as NodeCoreBackendType } from '../electron/node-core-backend.ts';
import type { RustCoreBackend as RustCoreBackendType } from '../electron/rust-core-backend.ts';

const require = createRequire(import.meta.url);
const { NodeCoreBackend } = require('../dist-electron/node-core-backend.js') as {
  NodeCoreBackend: typeof NodeCoreBackendType;
};
const { RustCoreBackend } = require('../dist-electron/rust-core-backend.js') as {
  RustCoreBackend: typeof RustCoreBackendType;
};

const executable = process.platform === 'win32' ? 'shellspan-core.exe' : 'shellspan-core';
const temporary = await mkdtemp(join(tmpdir(), 'shellspan-stage6-diff-'));
const rustRoot = join(temporary, 'rust');
const nodeRoot = join(temporary, 'node');
await Promise.all([mkdir(rustRoot), mkdir(nodeRoot)]);
const environment = (home: string) => ({
  ...process.env,
  SHELLSPAN_HOME: home,
  SHELLSPAN_APP_DATA: join(home, 'app'),
  SHELLSPAN_LOG_DIR: join(home, 'logs'),
  SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
  SHELLSPAN_NODE_DOMAINS: 'storage,credentials,llm,agent-runtime',
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
      key === 'timeUnixMs' || key === 'createdAtUnixMs' || key === 'recordedAtUnixMs'
        ? '<TIME>'
        : normalize(entry, root),
    ]),
  );
}

async function both(command: string, args: object = {}) {
  const [rustResult, nodeResult] = await Promise.all([
    rust.invoke(command, expandRoot(args, rustRoot) as object),
    node.invoke(command, expandRoot(args, nodeRoot) as object),
  ]);
  assert.deepEqual(normalize(rustResult, rustRoot), normalize(nodeResult, nodeRoot), command);
  if (!nodeResult.ok) throw new Error(String(nodeResult.error));
  return nodeResult.value;
}

function expandRoot(value: unknown, root: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => expandRoot(entry, root));
  if (!value || typeof value !== 'object') return value === '<ROOT>' ? root : value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      expandRoot(entry, root),
    ]),
  );
}

try {
  await Promise.all([rust.ready, node.ready]);
  const create = {
    request: {
      sessionId: 'stage6-session',
      taskId: 'stage6-task',
      goal: 'Inspect the differential fixture',
      target: {
        kind: 'local',
        targetId: 'local-target',
        sessionId: 'terminal-session',
        localRoot: '<ROOT>',
      },
      permissionMode: 'requestApproval',
      successCriteria: ['Node and Rust project the same immutable prefix'],
      capabilityScope: {
        toolNames: ['read_file', 'list_directory'],
        effects: ['readOnly'],
        targetIds: ['local-target'],
      },
    },
  };
  await both('agent_runtime_create_session', create);
  const queued = (await both('agent_runtime_followup', {
    input: {
      sessionId: 'stage6-session',
      messageId: 'message-1',
      clientSubmissionId: 'submission-1',
      content: 'Continue with the fixture',
    },
  })) as { eventCount: number };
  await both('agent_runtime_set_permission', {
    input: { sessionId: 'stage6-session', mode: 'scopedAutopilot' },
  });
  await both('agent_runtime_rename_session', {
    input: {
      sessionId: 'stage6-session',
      expectedRevision: queued.eventCount + 1,
      clientOperationId: 'rename-1',
      title: 'Differential fixture',
    },
  });
  await both('agent_runtime_get_session', { input: { sessionId: 'stage6-session' } });
  await both('agent_runtime_get_events', {
    request: { sessionId: 'stage6-session', cursor: 0, limit: 100 },
  });
  await both('agent_runtime_get_committed_events', {
    request: { sessionId: 'stage6-session', afterSeq: 1, limit: 100 },
  });
  await both('agent_runtime_list_sessions', { request: { limit: 100 } });
  await both('agent_runtime_create_session', {
    request: {
      ...create.request,
      sessionId: 'stage6-archive',
      taskId: 'stage6-archive-task',
      goal: 'Archive an idle differential fixture',
    },
  });
  await both('agent_runtime_archive_session', { input: { sessionId: 'stage6-archive' } });
  console.log(
    'Stage 6 Rust/Node immutable Session, Inbox, projection, paging, and archive fixtures matched.',
  );
} finally {
  await Promise.all([rust.stop(), node.stop()]);
  await rm(temporary, { recursive: true, force: true });
}
