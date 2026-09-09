import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogs } from '../logs.ts';

test('logs retain the original panel format, targets and ordered rotation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellspan-logs-'));
  try {
    const logs = createLogs(dir);
    await logs.write('backend', 'info', 'ready', 'shellspan::session');
    assert.match(
      await fs.readFile(path.join(dir, 'backend.log'), 'utf8'),
      /^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[INFO\]\[shellspan::session\] ready\n$/,
    );
    await fs.writeFile(path.join(dir, 'backend.log'), 'x'.repeat(2 * 1024 * 1024));
    await Promise.all([logs.write('backend', 'info', 'one'), logs.write('backend', 'warn', 'two')]);
    await logs.flush();
    assert.equal((await fs.stat(path.join(dir, 'backend.1.log'))).size, 2 * 1024 * 1024);
    const text = await fs.readFile(path.join(dir, 'backend.log'), 'utf8');
    assert.ok(text.indexOf('one') < text.indexOf('two'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
