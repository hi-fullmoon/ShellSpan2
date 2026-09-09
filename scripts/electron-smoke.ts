import type { DesktopBridge } from '../src/lib/desktop/core.ts';

declare global {
  interface Window {
    __smokeOutput: string;
    require?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}
// Keep the real renderer bridge contract in this browser integration test.
type SmokeWindow = Window & { shellspan: DesktopBridge };
import { _electron as electron } from 'playwright';
import { NativeHost } from '../electron/native.ts';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shellspan-electron-ui-'));
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    SHELLSPAN_HOME: root,
    SHELLSPAN_APP_DATA: path.join(root, 'app'),
    SHELLSPAN_LOG_DIR: path.join(root, 'logs'),
    SHELLSPAN_CHROMIUM_DATA: path.join(root, 'chromium'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes('--packaged');
  const seed = new NativeHost(
    path.resolve(
      'native/target',
      packaged ? 'release' : 'debug',
      process.platform === 'win32' ? 'shellspan-core.exe' : 'shellspan-core',
    ),
    env,
  );
  try {
    await seed.ready;
    const result = await seed.invoke('save_preferences', {
      entries: [
        ['startupUpdateCheck', 'false'],
        [
          'electron.webviewMigration.v1',
          JSON.stringify({
            version: 1,
            localStorage: { 'shellspan.aiPanelWidth': '480' },
            drafts: [{ owner: 'agent:migration-smoke', revision: 1, text: '旧版草稿', images: [] }],
          }),
        ],
      ],
    });
    assert.equal(result.ok, true);
  } finally {
    await seed.stop();
  }
  const application = await electron.launch(
    packaged
      ? {
          executablePath: path.resolve('release/mac-arm64/ShellSpan.app/Contents/MacOS/ShellSpan'),
          args: [],
          env,
          timeout: 60000,
        }
      : { args: ['.'], env, timeout: 60000 },
  );
  const errors: string[] = [];
  try {
    const page = await application.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('[data-desktop-drag-region]', { timeout: 30000 });
    const state = await page.evaluate(async () => ({
      bridge: !!(window as SmokeWindow).shellspan,
      version: await (window as SmokeWindow).shellspan.version(),
      commands: Object.keys((window as SmokeWindow).shellspan.commands).length,
      node: typeof window.require,
      tauri: typeof window.__TAURI_INTERNALS__,
      title: document.title,
      root: document.querySelector('#root')!.children.length,
    }));
    assert.equal(state.bridge, true);
    assert.equal(state.commands, 141);
    assert.equal(state.node, 'undefined');
    assert.equal(state.tauri, 'undefined');
    assert.ok(state.root);
    await page.screenshot({
      path: `artifacts/migration/${packaged ? 'packaged' : 'electron'}-main.png`,
    });
    assert.equal(await page.evaluate(() => localStorage.getItem('shellspan.aiPanelWidth')), '480');
    const migrated = await page.evaluate(
      () =>
        new Promise<{ text: string }>((resolve, reject) => {
          const request = indexedDB.open('shellspan-image-drafts-v1', 2);
          request.onsuccess = () => {
            const db = request.result;
            const read = db
              .transaction('drafts')
              .objectStore('drafts')
              .get('agent:migration-smoke');
            read.onsuccess = () => {
              db.close();
              resolve(read.result);
            };
            read.onerror = () => reject(read.error);
          };
        }),
    );
    assert.equal(migrated.text, '旧版草稿');
    await page.getByRole('button', { name: '终端', exact: true }).click();
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    await page.evaluate(() => {
      window.__smokeOutput = '';
      const seen = new Set();
      (window as SmokeWindow).shellspan.on('ssh-status', (status) => {
        if (!seen.has(status.sessionId)) {
          seen.add(status.sessionId);
          (window as SmokeWindow).shellspan.on(`ssh-data:${status.sessionId}`, (chunk) => {
            window.__smokeOutput += chunk;
          });
        }
      });
    });
    await page.getByRole('button', { name: '本地终端', exact: true }).click();
    const terminal = page.locator('.xterm-helper-textarea');
    await terminal.waitFor({ state: 'attached' });
    await terminal.focus();
    await page.keyboard.type("printf 'ELECTRON_UI_%s\\n' 'OK'");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__smokeOutput.includes('ELECTRON_UI_OK'), null, {
      timeout: 15000,
    });
    await page.screenshot({
      path: `artifacts/migration/${packaged ? 'packaged' : 'electron'}-terminal.png`,
    });
    await page.getByRole('button', { name: 'SFTP', exact: true }).click();
    await page.screenshot({
      path: `artifacts/migration/${packaged ? 'packaged' : 'electron'}-sftp.png`,
    });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send(
        'desktop:event',
        'system-open-settings',
        null,
      ),
    );
    await page.getByRole('dialog').waitFor();
    await page.screenshot({
      path: `artifacts/migration/${packaged ? 'packaged' : 'electron'}-settings.png`,
    });
    await page.keyboard.press('Escape');
    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return {
        bounds: w.getBounds(),
        minimum: w.getMinimumSize(),
        webPreferences: (
          w.webContents as Electron.WebContents & {
            getLastWebPreferences(): Electron.WebPreferences;
          }
        ).getLastWebPreferences(),
      };
    });
    assert.deepEqual(preferences.minimum, [1200, 760]);
    assert.equal(preferences.webPreferences.contextIsolation, true);
    assert.equal(preferences.webPreferences.sandbox, true);
    assert.equal(preferences.webPreferences.nodeIntegration, false);
    assert.equal(
      await page.evaluate(
        async () =>
          (await navigator.permissions.query({ name: 'clipboard-read' as PermissionName })).state,
      ),
      'granted',
    );
    const result = await page.evaluate(() =>
      (window as SmokeWindow).shellspan.commands.list_profiles(),
    );
    assert.deepEqual(result, { ok: true, value: [] });
    const unknown = await page.evaluate(() =>
      Object.keys((window as SmokeWindow).shellspan.commands).includes('exec'),
    );
    assert.equal(unknown, false);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify(
        {
          passed: true,
          packaged,
          state,
          bounds: preferences.bounds,
          checks: [
            'actual Electron window',
            'isolated preload',
            '141-command bridge',
            'real native IPC',
            'unchanged window constraints',
            'no page exceptions',
            'legacy width and IndexedDB draft import',
            'terminal via original UI',
            'SFTP navigation',
            'settings via desktop event',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await application.evaluate(({ app }) => {
      app.emit('window-all-closed');
    });
    // Use the same acknowledged native shutdown as the application's exit action.
    const page = application.windows()[0];
    if (page)
      await page
        .evaluate(() => (window as SmokeWindow).shellspan?.commands.request_app_exit())
        .catch(() => {});
    await application.close();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
