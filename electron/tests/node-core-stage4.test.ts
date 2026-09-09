import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NodeCoreBackend } from '../node-core-backend.ts';
import { endpoint, matchPattern } from '../node-core/host-trust.ts';
import { linuxSnapshot, macosSnapshot } from '../node-core/remote-health.ts';

async function waitFor(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('stage 4 test deadline exceeded');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('known-host endpoints and hashed patterns are exact', () => {
  assert.equal(endpoint('example.com', 22), 'example.com');
  assert.equal(endpoint('example.com', 2222), '[example.com]:2222');
  const salt = randomBytes(20);
  const value = '[example.com]:2222';
  const digest = createHmac('sha1', salt).update(value).digest('base64');
  const pattern = `|1|${salt.toString('base64')}|${digest}`;
  assert.equal(matchPattern(pattern, value), true);
  assert.equal(matchPattern(pattern, 'example.com'), false);
});

test('remote health parsers preserve Linux and macOS metrics', () => {
  const linux = linuxSnapshot(`TB_HOSTNAME=linux-box
TB_KERNEL=6.8
TB_ARCH=x86_64
TB_OS_VERSION=Linux Fixture
TB_CPU_COUNT=4
TB_UPTIME=123.9
TB_LOAD=1.0 2.0 3.0
TB_CPU_1=cpu 100 0 50 800 10 0 0 0
TB_CPU_2=cpu 120 0 60 850 10 0 0 0
TB_MEM=1000 600 400
TB_DISK=100 60 40 60% /
`);
  assert.equal(linux.system.osFamily, 'linux');
  assert.equal(linux.system.uptimeSecs, 123);
  assert.equal(linux.memory.usagePercent, 60);
  assert.equal(linux.disk.totalBytes, 102400);
  assert.ok(linux.cpu.usagePercent > 0);

  const macos = macosSnapshot(`TB_HOSTNAME=mac-box
TB_KERNEL=25.0
TB_ARCH=arm64
TB_OS_VERSION=26.0
TB_CPU_COUNT=10
TB_LOAD={ 1.5 2.5 3.5 }
TB_CPU=12.5
TB_MEM_TOTAL=1000
TB_MEM_AVAILABLE=250
TB_NOW=2000
TB_BOOT={ sec = 500, usec = 0 }
TB_DISK=100 75 25 75% /
`);
  assert.equal(macos.system.osFamily, 'macos');
  assert.equal(macos.system.uptimeSecs, 1500);
  assert.equal(macos.cpu.usagePercent, 12.5);
  assert.equal(macos.memory.usagePercent, 75);
  assert.deepEqual(macos.load, { oneMinute: 1.5, fiveMinutes: 2.5, fifteenMinutes: 3.5 });
});

test(
  'Node local PTY gates, pauses, resumes and kills the process group',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-stage4-pty-'));
    const backend = new NodeCoreBackend({
      ...process.env,
      SHELLSPAN_HOME: root,
      SHELLSPAN_NODE_DOMAINS: 'terminal',
    });
    let output = '';
    backend.on('event', (event, payload) => {
      if (event.startsWith('ssh-data:')) output += String(payload);
    });
    try {
      await backend.ready;
      const created = await backend.invoke('create_local_session', { cols: 80, rows: 24 });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const sessionId = (created.value as { sessionId: string }).sessionId;
      await backend.invoke('mark_session_ready', { sessionId });
      await backend.invoke('set_session_output_paused', { sessionId, paused: true });
      await backend.invoke('write_session', {
        sessionId,
        data:
          process.platform === 'win32'
            ? `$child = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 30' -PassThru; Write-Output \"CHILD_PID=$($child.Id)\"; Write-Output 'EXEC_MARKER'\r`
            : "sleep 30 & printf 'CHILD_PID=%s\\n' $!; printf 'EXEC_%s\\n' 'MARKER'\n",
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(output.includes('EXEC_MARKER'), false);
      await backend.invoke('set_session_output_paused', { sessionId, paused: false });
      await waitFor(() => output.includes('EXEC_MARKER'));
      const childPid = Number(output.match(/CHILD_PID=(\d+)/)?.[1]);
      assert.ok(childPid > 0, JSON.stringify(output));
      const closed = once(backend, 'event');
      await backend.invoke('close_session', { sessionId });
      await waitFor(() => {
        try {
          process.kill(childPid, 0);
          return false;
        } catch {
          return true;
        }
      });
      await closed;
    } finally {
      await backend.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an abnormal Node Core exit leaves no local terminal process tree',
  { timeout: 15000, skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'shellspan-stage4-pty-crash-'));
    const backend = new NodeCoreBackend({
      ...process.env,
      SHELLSPAN_HOME: root,
      SHELLSPAN_NODE_DOMAINS: 'terminal',
    });
    let output = '';
    backend.on('event', (event, payload) => {
      if (event.startsWith('ssh-data:')) output += String(payload);
    });
    try {
      await backend.ready;
      const created = await backend.invoke('create_local_session', { cols: 80, rows: 24 });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const sessionId = (created.value as { sessionId: string }).sessionId;
      await backend.invoke('mark_session_ready', { sessionId });
      await backend.invoke('write_session', {
        sessionId,
        data: "sleep 30 & printf 'CRASH_CHILD_PID=%s\\n' $!\n",
      });
      await waitFor(() => /CRASH_CHILD_PID=\d+/.test(output));
      const childPid = Number(output.match(/CRASH_CHILD_PID=(\d+)/)?.[1]);
      assert.ok(childPid > 0, JSON.stringify(output));
      backend.host.child.kill('SIGKILL');
      await waitFor(() => {
        try {
          process.kill(childPid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      await backend.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
