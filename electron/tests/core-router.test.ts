import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  CoreBackendRouter,
  canaryCommand,
  commandMetadata,
  parseBackendConfig,
  parseCanaryMode,
  stageThreeNodeDomains,
  stageFourNodeDomains,
  stageFiveNodeDomains,
  stageTwoNodeDomains,
} from '../core-router.ts';
import type { BackendKind, CoreBackendEvents, CoreRequestType } from '../core-backend.ts';
import type { CoreResponse } from '../types.ts';

class FakeBackend extends EventEmitter<CoreBackendEvents> {
  readonly ready = Promise.resolve({ type: 'ready' as const, protocol: 1, terminalChannel: true });
  stopping = false;
  calls: Array<[string, string]> = [];
  callArgs: object[] = [];
  stopCalls = 0;
  response: CoreResponse;

  constructor(
    readonly kind: BackendKind,
    response?: CoreResponse,
  ) {
    super();
    this.response = response ?? { ok: true, value: kind };
  }
  invoke(command: string, args = {}, type: CoreRequestType = 'request') {
    this.calls.push([type, command]);
    this.callArgs.push(args);
    return Promise.resolve(this.response);
  }
  validate(command: string) {
    this.calls.push(['validate', command]);
    return Promise.resolve({ ok: true, value: null } as CoreResponse);
  }
  async stop() {
    this.stopping = true;
    this.stopCalls += 1;
  }
  pauseTerminalEvents() {}
  resumeTerminalEvents() {}
}

test('backend configuration accepts only complete frozen domains', () => {
  const routes = parseBackendConfig(' terminal:node, storage:rust ');
  assert.equal(routes.get('terminal'), 'node');
  assert.equal(routes.get('storage'), 'rust');
  for (const domain of ['health', 'local-fs', 'logs', 'petdex'])
    assert.equal(parseBackendConfig().get(domain), 'node');
  for (const invalid of [
    'create_session:node',
    'terminal:other',
    'terminal:node:extra',
    'terminal:node,terminal:rust',
  ])
    assert.throws(() => parseBackendConfig(invalid));
  assert.equal(parseCanaryMode(), undefined);
  assert.equal(parseCanaryMode('compare'), 'compare');
  assert.throws(() => parseCanaryMode('shadow'));
});

test('storage and credential dependency ownership cannot be split', () => {
  const rust = new FakeBackend('rust');
  const node = new FakeBackend('node');
  assert.throws(
    () => new CoreBackendRouter(rust, node, parseBackendConfig('storage:rust,credentials:node')),
    /selected together/,
  );
  assert.throws(
    () => new CoreBackendRouter(rust, node, parseBackendConfig('storage:node,credentials:rust')),
    /selected together/,
  );
});

test('an unset canary follows its complete domain route', async () => {
  const rust = new FakeBackend('rust');
  const node = new FakeBackend('node');
  const router = new CoreBackendRouter(rust, node, parseBackendConfig('local-fs:node'));
  await router.invoke(canaryCommand, { path: '/fixture' });
  assert.equal(rust.calls.length, 0);
  assert.deepEqual(node.calls, [['request', canaryCommand]]);
  await router.stop();
});

test('all Stage 2 commands have single Node ownership by default and domain rollback is complete', async () => {
  const rust = new FakeBackend('rust');
  const node = new FakeBackend('node');
  const defaults = new CoreBackendRouter(rust, node, parseBackendConfig());
  const stageTwoCommands = [...commandMetadata.values()].filter((command) =>
    (stageTwoNodeDomains as readonly string[]).includes(command.domain),
  );
  assert.equal(stageTwoCommands.length, 15);
  for (const command of stageTwoCommands)
    assert.equal(defaults.backendFor(command.name), node, command.name);
  await defaults.stop();

  const rollbackRoutes = parseBackendConfig(
    stageTwoNodeDomains.map((domain) => `${domain}:rust`).join(','),
  );
  const rollback = new CoreBackendRouter(
    new FakeBackend('rust'),
    new FakeBackend('node'),
    rollbackRoutes,
  );
  for (const command of stageTwoCommands)
    assert.equal(rollback.backendFor(command.name).kind, 'rust', command.name);
  await rollback.stop();
});

test('all Stage 3 commands default to Node with whole-domain rollback', async () => {
  const rust = new FakeBackend('rust');
  const node = new FakeBackend('node');
  const defaults = new CoreBackendRouter(rust, node, parseBackendConfig());
  const commands = [...commandMetadata.values()].filter((command) =>
    (stageThreeNodeDomains as readonly string[]).includes(command.domain),
  );
  assert.equal(commands.length, 29);
  for (const command of commands) assert.equal(defaults.backendFor(command.name), node);
  await defaults.stop();

  const routes = parseBackendConfig(
    [...stageThreeNodeDomains, ...stageFourNodeDomains, ...stageFiveNodeDomains]
      .map((domain) => `${domain}:rust`)
      .join(','),
  );
  const rollback = new CoreBackendRouter(new FakeBackend('rust'), new FakeBackend('node'), routes);
  for (const command of commands) assert.equal(rollback.backendFor(command.name).kind, 'rust');
  await rollback.stop();
});

test('all 40 Stage 4 commands share Node connection and credential ownership', async () => {
  const rust = new FakeBackend('rust');
  const node = new FakeBackend('node');
  const router = new CoreBackendRouter(rust, node, parseBackendConfig());
  const commands = [...commandMetadata.values()].filter((command) =>
    (stageFourNodeDomains as readonly string[]).includes(command.domain),
  );
  assert.equal(commands.length, 40);
  for (const command of commands) assert.equal(router.backendFor(command.name), node);
  await router.stop();
  assert.throws(
    () =>
      new CoreBackendRouter(
        new FakeBackend('rust'),
        new FakeBackend('node'),
        parseBackendConfig('terminal:rust'),
      ),
    /selected together/,
  );
});

test('all 9 Stage 5 LLM commands default to Node with whole-domain rollback', async () => {
  const rust = new FakeBackend('rust');
  const node = new FakeBackend('node');
  const defaults = new CoreBackendRouter(rust, node, parseBackendConfig());
  const commands = [...commandMetadata.values()].filter((command) =>
    (stageFiveNodeDomains as readonly string[]).includes(command.domain),
  );
  assert.equal(commands.length, 9);
  for (const command of commands) assert.equal(defaults.backendFor(command.name), node);
  await defaults.stop();

  const rollback = new CoreBackendRouter(
    new FakeBackend('rust'),
    new FakeBackend('node'),
    parseBackendConfig('llm:rust'),
  );
  for (const command of commands) assert.equal(rollback.backendFor(command.name).kind, 'rust');
  await rollback.stop();
  assert.throws(
    () =>
      new CoreBackendRouter(
        new FakeBackend('rust'),
        new FakeBackend('node'),
        parseBackendConfig(
          `storage:rust,credentials:rust,llm:node,${stageFourNodeDomains
            .map((domain) => `${domain}:rust`)
            .join(',')}`,
        ),
      ),
    /requires Node storage and credentials/,
  );
});

test('a stateful domain routes all commands to one backend', async () => {
  const rust = new FakeBackend('rust');
  const node = new FakeBackend('node');
  const router = new CoreBackendRouter(rust, node, parseBackendConfig('terminal:node'));
  await router.invoke('create_session');
  await router.invoke('write_session');
  await router.invoke('resize_session');
  await router.invoke('close_session');
  assert.deepEqual(
    node.calls.map(([, command]) => command),
    ['create_session', 'write_session', 'resize_session', 'close_session'],
  );
  assert.deepEqual(rust.calls, []);
  await Promise.all([router.stop(), router.stop()]);
  assert.equal(rust.stopCalls, 1);
  assert.equal(node.stopCalls, 1);
});

test('migration reads stay Rust-owned and lifecycle events are forwarded', async () => {
  const rust = new FakeBackend('rust');
  const node = new FakeBackend('node');
  const router = new CoreBackendRouter(rust, node, parseBackendConfig('storage:node'));
  const logs: string[] = [];
  router.on('log', (record) => logs.push(record.message));
  node.emit('log', { level: 'info', message: 'node-ready' });
  await router.invoke('migration-read', { key: 'k', offset: 0 }, 'migration-read');
  assert.deepEqual(rust.calls, [['migration-read', 'migration-read']]);
  assert.deepEqual(logs, ['node-ready']);
  await router.stop();
});

test('canary switches between Rust and Node and compare rejects drift', async () => {
  const fixture = { ok: true, value: 'same bytes\n' } as const;
  for (const mode of ['rust', 'node'] as const) {
    const rust = new FakeBackend('rust', fixture);
    const node = new FakeBackend('node', fixture);
    const router = new CoreBackendRouter(rust, node, new Map(), mode);
    assert.deepEqual(await router.invoke(canaryCommand, { path: '/fixture' }), fixture);
    assert.equal(rust.calls.length, mode === 'rust' ? 1 : 0);
    assert.equal(node.calls.length, mode === 'node' ? 1 : 0);
    await router.stop();
  }

  const rust = new FakeBackend('rust', fixture);
  const node = new FakeBackend('node', { ok: true, value: 'different' });
  const router = new CoreBackendRouter(rust, node, new Map(), 'compare');
  assert.deepEqual(await router.invoke(canaryCommand, { path: '/fixture' }), {
    ok: false,
    error: `Rust/Node canary mismatch for ${canaryCommand}`,
  });
  assert.equal(rust.calls.length, 1);
  assert.equal(node.calls.length, 1);
  await router.stop();
});

test('private Rust activity events are bridged to the Node Petdex adapter', async () => {
  const rust = new FakeBackend('rust', { ok: true, value: null });
  const node = new FakeBackend('node');
  const router = new CoreBackendRouter(rust, node, parseBackendConfig());
  rust.emit('event', '__core-petdex-activity', {
    kind: 'sftp-started',
    operationId: 'upload-1',
  });
  rust.emit('event', '__core-petdex-activity', {
    kind: 'sftp-succeeded',
    operationId: 'upload-1',
  });
  rust.emit('event', '__core-petdex-activity', {
    kind: 'ssh-closed',
    operationId: 'ssh-1',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    node.calls.map(([, command]) => command),
    ['__petdex_notify', '__petdex_notify', '__petdex_notify'],
  );
  assert.deepEqual(node.callArgs, [
    { kind: 'sftp-started', operationId: 'upload-1' },
    { kind: 'sftp-succeeded', operationId: 'upload-1' },
    { kind: 'ssh-closed', operationId: 'ssh-1' },
  ]);
  await router.stop();
});
