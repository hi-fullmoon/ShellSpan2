import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function createLogs(directory: string) {
  const queues = new Map<string, Promise<void>>();
  function write(
    source: 'frontend' | 'backend',
    level: string,
    message: string,
    target = source === 'frontend' ? 'webview' : 'shellspan',
  ) {
    const previous = queues.get(source) ?? Promise.resolve();
    const task = previous
      .then(async () => {
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `${source}.log`);
        const size = await fs.stat(file).then(
          (s) => s.size,
          () => 0,
        );
        if (size >= 2 * 1024 * 1024) {
          await fs.rm(path.join(directory, `${source}.9.log`), { force: true });
          for (let i = 8; i >= 1; i--)
            await fs
              .rename(
                path.join(directory, `${source}.${i}.log`),
                path.join(directory, `${source}.${i + 1}.log`),
              )
              .catch((e) => {
                if (e.code !== 'ENOENT') throw e;
              });
          await fs.rename(file, path.join(directory, `${source}.1.log`));
        }
        const date = new Date();
        const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}][${date.toTimeString().slice(0, 8)}`;
        await fs.appendFile(file, `[${stamp}][${level.toUpperCase()}][${target}] ${message}\n`);
      })
      .catch((error) => console.error('Log write failed:', error.message));
    queues.set(source, task);
    return task;
  }
  return { write, flush: () => Promise.all(queues.values()) };
}
export { createLogs };
