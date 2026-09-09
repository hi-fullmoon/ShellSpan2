const { NativeHost } = require('../dist-electron/native.js');
const { validateCommand } = require('../dist-electron/validation.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellspan-contract-'));
  const host = new NativeHost(path.resolve('native/target/debug/shellspan-core'), {
    ...process.env,
    SHELLSPAN_HOME: root,
    SHELLSPAN_APP_DATA: path.join(root, 'app'),
    SHELLSPAN_LOG_DIR: path.join(root, 'logs'),
  });
  let timer = setTimeout(() => {
    host.fail(new Error('contract probe deadline'));
  }, 10000);
  const checks = [];
  const call = (name, args = {}) => {
    validateCommand(name, args);
    return host.invoke(name, args);
  };
  try {
    await host.ready;
    assert.deepEqual(await call('list_profiles', { ignored: 'baseline permits extra keys' }), {
      ok: true,
      value: [],
    });
    checks.push('extra keys ignored');
    assert.deepEqual(await call('load_terminal_workspace'), { ok: true, value: null });
    checks.push('Option None remains null');
    assert.deepEqual(await call('save_preferences', { entries: [['boundary', '汉字']] }), {
      ok: true,
      value: null,
    });
    checks.push('unit remains null');
    const bad = await call('save_preferences', { entries: [['boundary', { invalid: true }]] });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /invalid args `entries` for command `save_preferences`/);
    checks.push('nested tuple rejected in actual native route');
    for (const [name, args, error] of [
      [
        'resize_session',
        { sessionId: 's', cols: -1, rows: 24 },
        'invalid args `cols` for command `resize_session`: invalid value: integer `-1`, expected u32',
      ],
      [
        'write_session',
        { sessionId: 's', data: 1 },
        'invalid args `data` for command `write_session`: invalid type: integer `1`, expected a string',
      ],
      [
        'write_session',
        { data: '' },
        'invalid args `sessionId` for command `write_session`: command write_session missing required key sessionId',
      ],
    ])
      assert.deepEqual(await call(name, args), { ok: false, error });
    checks.push('native scalar/missing errors match fixed-B command/key format');
    for (const [name, args, error] of [
      [
        'export_log_file',
        { content: '' },
        'invalid args `name` for command `export_log_file`: command export_log_file missing required key name',
      ],
      [
        'export_log_file',
        { name: null, content: '' },
        'invalid args `name` for command `export_log_file`: invalid type: null, expected a string',
      ],
      [
        'pick_local_folder',
        { title: 2 },
        'invalid args `title` for command `pick_local_folder`: invalid type: integer `2`, expected a string',
      ],
    ])
      assert.deepEqual(await host.validate(name, args), { ok: false, error });
    assert.deepEqual(await host.validate('pick_local_folder', { title: null }), {
      ok: true,
      value: null,
    });
    assert.deepEqual(await host.validate('pick_local_files'), { ok: true, value: null });
    assert.equal((await host.validate('request_app_exit')).ok, false);
    checks.push(
      'four Electron-owned commands validate in native without opening dialogs or invoking business',
    );
    const request = {
      name: 'bad',
      host: '',
      port: 22,
      username: '',
      authMethod: 'password',
      terminalCols: 80,
      terminalRows: 24,
    };
    const error = await call('create_session', { request });
    assert.equal(error.ok, false);
    assert.equal(typeof error.error, 'object');
    checks.push('valid shape preserves structured business error');
    for (const value of [
      { ...request, port: 65536 },
      { ...request, jumpHost: { port: '22' } },
    ]) {
      const result = await call('create_session', { request: value });
      assert.equal(result.ok, false);
      assert.match(result.error, /invalid args `request` for command `create_session`/);
    }
    checks.push('nested structure and u16 range rejected before business execution');
    console.log(JSON.stringify({ checks }, null, 2));
  } finally {
    clearTimeout(timer);
    await host.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
