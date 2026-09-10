import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import manifest from '../contracts/v1/manifest.json';
import { NodeCoreBackend } from '../node-core-backend.ts';
import { enabledNodeCoreDomains, nodeCoreDomains } from '../node-core/state.ts';

test('all non-desktop commands and domains have immutable Node ownership', () => {
  const nodeCommands = manifest.commands.filter((command) => command.currentOwner === 'node');
  const desktopCommands = manifest.commands.filter(
    (command) => command.currentOwner === 'electron',
  );
  assert.equal(nodeCommands.length, 134);
  assert.equal(desktopCommands.length, 7);
  assert.deepEqual(
    new Set(nodeCommands.map((command) => command.domain)),
    new Set([...nodeCoreDomains].filter((domain) => domain !== 'desktop')),
  );

  const production = enabledNodeCoreDomains({ SHELLSPAN_NODE_DOMAINS: 'health' });
  assert.equal(production, nodeCoreDomains);
  const isolatedTest = enabledNodeCoreDomains({
    SHELLSPAN_NODE_CORE_TEST_MODE: '1',
    SHELLSPAN_NODE_DOMAINS: 'storage',
  });
  assert.deepEqual(isolatedTest, new Set(['storage']));
});

test('the Node-only Core serves bounded legacy WebView migration reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shellspan-stage7-'));
  const backend = new NodeCoreBackend({
    ...process.env,
    SHELLSPAN_HOME: root,
    SHELLSPAN_APP_DATA: join(root, 'app'),
    SHELLSPAN_LOG_DIR: join(root, 'logs'),
    SHELLSPAN_NODE_CORE_TEST_MODE: '1',
    SHELLSPAN_NODE_DOMAINS: 'storage',
  });
  try {
    await backend.ready;
    const snapshot = '旧版 WebView snapshot';
    const chunk = '界'.repeat(262145);
    assert.deepEqual(
      await backend.invoke('save_preferences', {
        entries: [
          ['electron.webviewMigration.v1', snapshot],
          ['electron.webviewMigration.chunk.0', chunk],
        ],
      }),
      { ok: true, value: null },
    );
    assert.deepEqual(
      await backend.invoke(
        'migration-read',
        { key: 'electron.webviewMigration.v1', offset: 0 },
        'migration-read',
      ),
      { ok: true, value: { text: snapshot, next: [...snapshot].length, done: true } },
    );
    assert.deepEqual(
      await backend.invoke(
        'migration-read',
        { key: 'electron.webviewMigration.chunk.0', offset: 0 },
        'migration-read',
      ),
      {
        ok: true,
        value: { text: '界'.repeat(262144), next: 262144, done: false },
      },
    );
    const invalid = await backend.invoke(
      'migration-read',
      { key: 'preferences.secret', offset: 0 },
      'migration-read',
    );
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.match(String(invalid.error), /Invalid migration read/);
  } finally {
    await backend.stop();
    await rm(root, { recursive: true, force: true });
  }
});
