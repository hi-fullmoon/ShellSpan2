import { execFileSync } from 'node:child_process';

const ownerPid = Number(process.argv[2]);
const terminalPid = Number(process.argv[3]);
if (
  !Number.isSafeInteger(ownerPid) ||
  ownerPid <= 0 ||
  !Number.isSafeInteger(terminalPid) ||
  terminalPid <= 0
)
  process.exit(2);

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function killTree() {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(terminalPid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {}
    return;
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-terminalPid, signal);
    } catch {}
  }
}

const timer = setInterval(() => {
  if (alive(ownerPid)) return;
  clearInterval(timer);
  killTree();
  process.exit(0);
}, 100);
