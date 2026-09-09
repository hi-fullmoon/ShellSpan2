import { CancellationRegistry } from './cancellation.ts';
import type { ConnectedSsh, ConnectionRequest, SshConnector } from './ssh.ts';
import type { Client, ClientChannel } from 'ssh2';

const OUTPUT_LIMIT = 64 * 1024;
const LINUX_COMMAND = `LC_ALL=C; export LC_ALL;
printf 'TB_HOSTNAME='; hostname;
printf 'TB_KERNEL='; uname -r;
printf 'TB_ARCH='; uname -m;
printf 'TB_OS_VERSION='; awk -F= '/^PRETTY_NAME=/ {sub(/^"/, "", $2); sub(/"$/, "", $2); print $2; found=1} END {if (!found) print "Linux"}' /etc/os-release;
printf 'TB_CPU_COUNT='; getconf _NPROCESSORS_ONLN;
printf 'TB_UPTIME='; cut -d ' ' -f 1 /proc/uptime;
printf 'TB_LOAD='; cut -d ' ' -f 1-3 /proc/loadavg;
printf 'TB_CPU_1='; sed -n '1p' /proc/stat;
sleep 1;
printf 'TB_CPU_2='; sed -n '1p' /proc/stat;
printf 'TB_MEM='; awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {available=$2} END {used=total-available; printf "%.0f %.0f %.0f\\n", total*1024, used*1024, available*1024}' /proc/meminfo;
printf 'TB_DISK='; df -Pk / | awk 'NR==2 {print $2, $3, $4, $5, $6}'`;
const MACOS_COMMAND = `LC_ALL=C; export LC_ALL;
printf 'TB_HOSTNAME='; hostname;
printf 'TB_KERNEL='; uname -r;
printf 'TB_ARCH='; uname -m;
printf 'TB_OS_VERSION='; sw_vers -productVersion;
printf 'TB_CPU_COUNT='; sysctl -n hw.ncpu;
printf 'TB_LOAD='; sysctl -n vm.loadavg;
printf 'TB_CPU='; top -l 2 -n 0 -s 1 | awk '/CPU usage/ {idle=$7} END {gsub(/%/, "", idle); print 100-idle}';
printf 'TB_MEM_TOTAL='; sysctl -n hw.memsize;
printf 'TB_MEM_AVAILABLE='; vm_stat | awk 'NR==1 {page=$8; gsub(/[^0-9]/, "", page)} /^Pages free:/ {free=$3} /^Pages inactive:/ {inactive=$3} /^Pages speculative:/ {speculative=$3} END {gsub(/\\./, "", free); gsub(/\\./, "", inactive); gsub(/\\./, "", speculative); printf "%.0f\\n", (free+inactive+speculative)*page}';
printf 'TB_NOW='; date +%s;
printf 'TB_BOOT='; sysctl -n kern.boottime;
printf 'TB_DISK='; df -Pk / | awk 'NR==2 {print $2, $3, $4, $5, $6}'`;

function execute(client: Client, command: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    client.exec(command, (error: Error | undefined, stream: ClientChannel) => {
      if (error) return reject(error);
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      const abort = () => stream.close();
      signal.addEventListener('abort', abort, { once: true });
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > OUTPUT_LIMIT) {
          stream.close();
          reject(new Error('remote command output exceeded the safety limit'));
        } else chunks.push(chunk);
      });
      stream.stderr.setEncoding('utf8');
      stream.stderr.on('data', (chunk: string) => {
        if (stderr.length < 4096) stderr += chunk;
      });
      stream.once('error', reject);
      stream.once('close', (code?: number) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(new Error('remote health collection cancelled'));
        else if (code && code !== 0)
          reject(new Error(stderr.trim() || `remote command exited ${code}`));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  });
}

function fields(output: string) {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const equal = line.indexOf('=');
    if (equal > 0) values.set(line.slice(0, equal), line.slice(equal + 1).trim());
  }
  return values;
}

function numbers(value = '') {
  return value.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
}

function disk(value = '') {
  const parts = value.trim().split(/\s+/);
  const totalBytes = Number(parts[0] || 0) * 1024;
  const usedBytes = Number(parts[1] || 0) * 1024;
  const availableBytes = Number(parts[2] || 0) * 1024;
  return {
    totalBytes,
    usedBytes,
    availableBytes,
    usagePercent: totalBytes ? (usedBytes / totalBytes) * 100 : 0,
    mountPoint: parts[4] || '/',
  };
}

function linuxSnapshot(output: string) {
  const value = fields(output);
  const first = numbers(value.get('TB_CPU_1')).slice(1);
  const second = numbers(value.get('TB_CPU_2')).slice(1);
  const totalDelta = second.reduce((sum, item, index) => sum + item - (first[index] || 0), 0);
  const idleDelta = (second[3] || 0) + (second[4] || 0) - (first[3] || 0) - (first[4] || 0);
  const [totalBytes = 0, usedBytes = 0, availableBytes = 0] = numbers(value.get('TB_MEM'));
  const [oneMinute = 0, fiveMinutes = 0, fifteenMinutes = 0] = numbers(value.get('TB_LOAD'));
  return {
    system: {
      osFamily: 'linux',
      osVersion: value.get('TB_OS_VERSION') || 'Linux',
      hostname: value.get('TB_HOSTNAME') || '',
      kernelVersion: value.get('TB_KERNEL') || '',
      architecture: value.get('TB_ARCH') || '',
      cpuCount: Number(value.get('TB_CPU_COUNT') || 0),
      uptimeSecs: Math.floor(Number(value.get('TB_UPTIME') || 0)),
    },
    cpu: { usagePercent: totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0 },
    memory: {
      totalBytes,
      usedBytes,
      availableBytes,
      usagePercent: totalBytes ? (usedBytes / totalBytes) * 100 : 0,
    },
    disk: disk(value.get('TB_DISK')),
    load: { oneMinute, fiveMinutes, fifteenMinutes },
  };
}

function macosSnapshot(output: string) {
  const value = fields(output);
  const totalBytes = Number(value.get('TB_MEM_TOTAL') || 0);
  const availableBytes = Number(value.get('TB_MEM_AVAILABLE') || 0);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const [oneMinute = 0, fiveMinutes = 0, fifteenMinutes = 0] = numbers(value.get('TB_LOAD'));
  const boot = numbers(value.get('TB_BOOT'))[0] || 0;
  const now = Number(value.get('TB_NOW') || 0);
  return {
    system: {
      osFamily: 'macos',
      osVersion: value.get('TB_OS_VERSION') || '',
      hostname: value.get('TB_HOSTNAME') || '',
      kernelVersion: value.get('TB_KERNEL') || '',
      architecture: value.get('TB_ARCH') || '',
      cpuCount: Number(value.get('TB_CPU_COUNT') || 0),
      uptimeSecs: Math.max(0, now - boot),
    },
    cpu: { usagePercent: Number(value.get('TB_CPU') || 0) },
    memory: {
      totalBytes,
      usedBytes,
      availableBytes,
      usagePercent: totalBytes ? (usedBytes / totalBytes) * 100 : 0,
    },
    disk: disk(value.get('TB_DISK')),
    load: { oneMinute, fiveMinutes, fifteenMinutes },
  };
}

export class RemoteHealthManager {
  private readonly operations = new CancellationRegistry();
  constructor(private readonly ssh: SshConnector) {}

  cancel(id: string) {
    this.operations.cancel(id);
    return null;
  }

  async collect(request: {
    operationId: string;
    profileId: string;
    authorized: boolean;
    timeoutMs: number;
    connection: ConnectionRequest;
  }) {
    const source = {
      kind: 'sshReadOnly' as const,
      commandSetVersion: 'shellspan-read-only-v1',
      profileId: request.profileId,
      host: request.connection.host,
      port: request.connection.port,
      username: request.connection.username,
    };
    const result = (status: string, extra: object = {}) => ({
      operationId: request.operationId,
      profileId: request.profileId,
      status,
      checkedAt: Date.now(),
      source,
      ...extra,
    });
    if (!request.authorized)
      return result('unauthorized', {
        error: 'remote health collection requires authorization',
      });
    const controller = this.operations.begin(request.operationId);
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.min(60_000, Math.max(1_000, request.timeoutMs)),
    );
    let connection: ConnectedSsh | undefined;
    try {
      connection = await this.ssh.connect(request.connection, controller.signal);
      const cancelConnection = () => connection?.client.destroy();
      controller.signal.addEventListener('abort', cancelConnection, { once: true });
      const platform = (await execute(connection.client, 'uname -s', controller.signal)).trim();
      if (platform !== 'Linux' && platform !== 'Darwin')
        return result('unsupported', { error: `unsupported remote platform: ${platform}` });
      const output = await execute(
        connection.client,
        platform === 'Linux' ? LINUX_COMMAND : MACOS_COMMAND,
        controller.signal,
      );
      controller.signal.removeEventListener('abort', cancelConnection);
      return result('success', {
        snapshot: platform === 'Linux' ? linuxSnapshot(output) : macosSnapshot(output),
      });
    } catch (error) {
      return result(controller.signal.aborted ? (timedOut ? 'timedOut' : 'cancelled') : 'failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
      if (connection) this.ssh.close(connection);
      this.operations.finish(request.operationId, controller);
    }
  }

  stop() {
    this.operations.cancelAll();
  }
}

export { linuxSnapshot, macosSnapshot };
