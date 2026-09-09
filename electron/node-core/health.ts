import { cpus, freemem, platform, arch, totalmem } from 'node:os';
import { parse } from 'node:path';
import { readFile, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type CpuSnapshot = { idle: number; total: number };
const execFileAsync = promisify(execFile);

async function platformMetrics() {
  if (process.platform === 'linux') {
    const [status, memory] = await Promise.all([
      readFile('/proc/self/status', 'utf8'),
      readFile('/proc/meminfo', 'utf8'),
    ]);
    const field = (source: string, name: string) =>
      Number(source.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] || 0);
    const totalSwapBytes = field(memory, 'SwapTotal') * 1024;
    const freeSwapBytes = field(memory, 'SwapFree') * 1024;
    return {
      vszBytes: field(status, 'VmSize') * 1024,
      threads: field(status, 'Threads') || undefined,
      totalSwapBytes,
      freeSwapBytes,
    };
  }
  if (process.platform === 'darwin') {
    const [{ stdout: processInfo }, { stdout: swapInfo }] = await Promise.all([
      execFileAsync('/bin/ps', ['-o', 'vsz=', '-o', 'thcount=', '-p', String(process.pid)]),
      execFileAsync('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
    ]);
    const [vsz, threads] = processInfo.trim().split(/\s+/).map(Number);
    const amount = (name: string) => {
      const match = swapInfo.match(new RegExp(`${name} = ([\\d.]+)([KMG])`));
      if (!match) return 0;
      return (
        Number(match[1]) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2] as 'K' | 'M' | 'G']
      );
    };
    return {
      vszBytes: vsz * 1024,
      threads,
      totalSwapBytes: amount('total'),
      freeSwapBytes: amount('free'),
    };
  }
  return { vszBytes: 0, threads: undefined, totalSwapBytes: 0, freeSwapBytes: 0 };
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function percent(used: number, total: number) {
  return total ? (used / total) * 100 : 0;
}

export class HealthCollector {
  private previousCpu = cpuSnapshot();
  private previousProcess = process.cpuUsage();
  private previousAt = process.hrtime.bigint();

  async collect(appData: string, version: string) {
    const nowCpu = cpuSnapshot();
    const idleDelta = nowCpu.idle - this.previousCpu.idle;
    const totalDelta = nowCpu.total - this.previousCpu.total;
    this.previousCpu = nowCpu;
    const processCpu = process.cpuUsage(this.previousProcess);
    this.previousProcess = process.cpuUsage();
    const now = process.hrtime.bigint();
    const elapsedMicros = Number(now - this.previousAt) / 1000;
    this.previousAt = now;
    const memory = process.memoryUsage();
    const extra = await platformMetrics().catch(() => ({
      vszBytes: memory.rss + memory.external + memory.arrayBuffers,
      threads: undefined,
      totalSwapBytes: 0,
      freeSwapBytes: 0,
    }));
    const totalMemory = totalmem();
    const freeMemory = freemem();
    let disk = {
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      usagePercent: 0,
      mountPoint: parse(appData).root || '/',
    };
    try {
      const info = await statfs(appData, { bigint: true });
      const totalBytes = Number(info.blocks * info.bsize);
      const freeBytes = Number(info.bavail * info.bsize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      disk = {
        ...disk,
        totalBytes,
        usedBytes,
        freeBytes,
        usagePercent: percent(usedBytes, totalBytes),
      };
    } catch {}
    return {
      app: {
        pid: process.pid,
        rssBytes: memory.rss,
        vszBytes: extra.vszBytes,
        cpuPercent: elapsedMicros
          ? ((processCpu.user + processCpu.system) / elapsedMicros) * 100
          : 0,
        uptimeSecs: Math.floor(process.uptime()),
        ...(extra.threads === undefined ? {} : { threads: extra.threads }),
      },
      system: {
        totalMemoryBytes: totalMemory,
        usedMemoryBytes: totalMemory - freeMemory,
        freeMemoryBytes: freeMemory,
        memoryUsagePercent: percent(totalMemory - freeMemory, totalMemory),
        totalSwapBytes: extra.totalSwapBytes,
        usedSwapBytes: Math.max(0, extra.totalSwapBytes - extra.freeSwapBytes),
        freeSwapBytes: extra.freeSwapBytes,
        cpuPercent: totalDelta ? percent(totalDelta - idleDelta, totalDelta) : 0,
      },
      disk,
      appInfo: {
        version,
        platform: platform() === 'darwin' ? 'macos' : platform(),
        arch: arch() === 'arm64' ? 'aarch64' : arch(),
      },
    };
  }
}
