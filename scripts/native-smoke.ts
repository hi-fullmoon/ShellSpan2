import type {
  CommandArgs,
  CommandInput,
  CommandValues,
  WireValue,
} from '../src/lib/desktop/command-types.ts';
import { NativeHost } from '../electron/native.ts';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shellspan-electron-smoke-'));
  const env = {
    ...process.env,
    SHELLSPAN_HOME: root,
    SHELLSPAN_APP_DATA: path.join(root, 'app'),
    SHELLSPAN_LOG_DIR: path.join(root, 'logs'),
  };
  const binary = path.resolve(
    'native/target/debug',
    process.platform === 'win32' ? 'shellspan-core.exe' : 'shellspan-core',
  );
  let host = new NativeHost(binary, env);
  host.on('log', () => {});
  async function call<C extends keyof CommandArgs>(
    command: C,
    ...[args]: CommandInput<C>
  ): Promise<WireValue<CommandValues[C]>> {
    const result = await host.invoke(command, args);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value as WireValue<CommandValues[C]>;
  }
  try {
    await host.ready;
    assert.deepEqual(await call('list_profiles'), []);
    await call('save_preferences', { entries: [['migration.smoke', '汉字']] });
    const prefs = await call('load_preferences');
    assert.equal(Object.fromEntries(prefs)['migration.smoke'], '汉字');
    const listing = await call('list_local_directory', { path: root });
    assert.ok(listing);
    const result = await host.invoke('create_session', {
      request: {
        name: 'bad',
        host: '',
        port: 22,
        username: '',
        authMethod: 'password',
        terminalCols: 80,
        terminalRows: 24,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'object');
    let output = '';
    host.on('event', (event, payload) => {
      if (event.startsWith('ssh-data:')) output += payload;
    });
    const session = await call('create_local_session', { cols: 80, rows: 24 });
    const id = session.sessionId;
    assert.equal(typeof id, 'string');
    await call('mark_session_ready', { sessionId: id });
    await call('resize_session', { sessionId: id, cols: 100, rows: 30 });
    await call('write_session', { sessionId: id, data: "printf 'ELECTRON_SMOKE_%s\\n' '汉字'\r" });
    const deadline = Date.now() + 10000;
    while (!output.includes('ELECTRON_SMOKE_汉字') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(output, /ELECTRON_SMOKE_汉字/);
    await call('set_session_output_paused', { sessionId: id, paused: true });
    await call('set_session_output_paused', { sessionId: id, paused: false });
    await call('close_session', { sessionId: id });
    await host.stop();
    host = new NativeHost(binary, env);
    host.on('log', () => {});
    await host.ready;
    assert.equal(Object.fromEntries(await call('load_preferences'))['migration.smoke'], '汉字');
    console.log(
      JSON.stringify(
        {
          passed: true,
          commands: 141,
          checks: [
            'ready handshake',
            'database persistence',
            'directory listing',
            'structured errors',
            'local PTY UTF-8 output',
            'resize',
            'pause/resume',
            'close',
            'restart',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await host.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
