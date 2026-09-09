import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';

// The Node entry exports the executable path; Electron's declarations describe its runtime API.
if (typeof electron !== 'string') throw new Error('Electron executable path is unavailable');
const build = spawn('cargo', ['build', '--manifest-path', 'native/Cargo.toml'], {
  stdio: 'inherit',
});
const status = await new Promise<number | null>((resolve, reject) => {
  build.on('error', reject);
  build.on('exit', resolve);
});
if (status !== 0) process.exit(status ?? 1);
const server = await createServer();
await server.listen();
const env: NodeJS.ProcessEnv = { ...process.env, VITE_DEV_SERVER_URL: 'http://localhost:1420' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  child.kill();
  await server.close();
  process.exit(code);
}
child.on('error', (error) => {
  console.error(error);
  void close(1);
});
child.on('exit', (code) => void close(code ?? 0));
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
