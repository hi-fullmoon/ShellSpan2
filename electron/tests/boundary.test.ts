import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { trustedURL, verifySender } from '../security.ts';
import { isRendererEvent, rendererEvents } from '../events.ts';
import { validateCommand } from '../validation.ts';

test('only the exact trusted document and its main frame own IPC', () => {
  const entry = 'file:///Applications/ShellSpan/dist/index.html';
  const frame = { url: entry } as Electron.WebFrameMain;
  const contents = { mainFrame: frame } as Electron.WebContents;
  const win = { webContents: contents, isDestroyed: () => false } as Electron.BrowserWindow;
  // Minimal Electron doubles exercise identity checks without starting Chromium.
  const verify = (event: { sender: unknown; senderFrame: { url: string } | null }) =>
    verifySender(event as Electron.IpcMainInvokeEvent, win, entry);
  verify({ sender: contents, senderFrame: frame });
  for (const event of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: { url: entry } },
    { sender: contents, senderFrame: null },
  ])
    assert.throws(() => verify(event));
  for (const url of [
    'file:///tmp/index.html',
    entry + '?injected',
    'https://evil.test',
    'not a URL',
  ])
    assert.equal(trustedURL(url, entry), false);
  assert.equal(trustedURL(entry + '#settings', entry), true);
  assert.equal(trustedURL('http://localhost:1420/#x', entry, 'http://localhost:1420/'), true);
  for (const url of [
    'http://localhost:1420/other',
    'http://localhost:1421/',
    'http://user@localhost:1420/',
  ])
    assert.equal(trustedURL(url, entry, 'http://localhost:1420/'), false);
});
test('business/window events allow dynamic IDs but keep lifecycle private', () => {
  for (const name of [...rendererEvents, 'ssh-data:550e8400-e29b-41d4-a716-446655440000'])
    assert.equal(isRendererEvent(name), true);
  for (const name of [
    'desktop-exit',
    'desktop-restart',
    'arbitrary',
    'ssh-data:',
    'ssh-data:a\n',
    null,
    {},
  ])
    assert.equal(isRendererEvent(name), false);
});
test('nested JSON and primitive boundaries do not silently coerce invalid input', () => {
  for (const entries of [[['k', NaN]], [['k', () => {}]], [['k', 1n]]])
    assert.throws(() => validateCommand('save_preferences', { entries }));
  validateCommand('save_preferences', { entries: [['k', '值']] });
  validateCommand('agent_runtime_get_events', {
    request: { sessionId: 's', afterSeq: 9007199254740992 },
  }); // Native u64/Serde remains authoritative.
  validateCommand('pick_local_folder', { title: null });
  assert.doesNotThrow(() =>
    validateCommand('resize_session', { sessionId: 's', cols: 2 ** 32, rows: 24 }),
  );
});

test('Electron-owned schema errors are delegated to the same native Serde decoder', () => {
  // probe-contract.cjs asserts actual private validation errors and legal Option input.
  for (const [name, args] of [
    ['export_log_file', { content: '' }],
    ['export_log_file', { name: null, content: '' }],
    ['pick_local_folder', { title: 2 }],
  ] as const)
    assert.doesNotThrow(() => validateCommand(name, args));
});
