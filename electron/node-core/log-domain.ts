import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function listLogFiles(directory: string) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `failed to read log dir: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files = await Promise.all(
    names
      .filter(
        (name) =>
          (name.startsWith('backend') || name.startsWith('frontend')) && name.endsWith('.log'),
      )
      .map(async (name) => {
        const metadata = await stat(join(directory, name));
        return { name, size: metadata.size, modifiedAt: Math.floor(metadata.mtimeMs / 1000) };
      }),
  );
  files.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return files;
}

export async function readLogFile(directory: string, name: string) {
  if (
    name.includes('/') ||
    name.includes('\\') ||
    !(name.startsWith('backend') || name.startsWith('frontend')) ||
    !name.endsWith('.log')
  )
    throw new Error(`log file not found: ${name}`);
  const path = join(directory, name);
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`log file not found: ${name}`);
    throw new Error(
      `failed to read log file metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const size = Math.min(metadata.size, 2 * 1024 * 1024);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}
