import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class StorageClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stopped = false;
  readonly ready: Promise<void>;

  constructor(databasePath: string, testFailAfterVersion?: number) {
    this.worker = new Worker(join(__dirname, 'storage-worker.js'), {
      workerData: { databasePath, testFailAfterVersion },
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const initial = (message: { type?: string; error?: string }) => {
        if (message.type === 'ready') {
          this.worker.off('message', initial);
          resolve();
        } else if (message.type === 'failure') {
          this.worker.off('message', initial);
          reject(new Error(message.error || 'Storage initialization failed'));
        }
      };
      this.worker.on('message', initial);
      this.worker.once('error', reject);
      this.worker.once('exit', (code) => {
        if (!this.stopped && code !== 0) reject(new Error(`Storage worker exited (${code})`));
      });
    });
    this.ready.catch(() => {});
    this.worker.on(
      'message',
      (message: { id?: number; ok?: boolean; value?: unknown; error?: string }) => {
        if (message.id === undefined) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.error || 'Storage operation failed'));
      },
    );
    const fail = (error: Error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => {
      if (!this.stopped) fail(new Error(`Storage worker exited (${code})`));
    });
  }

  async invoke<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    if (this.stopped) throw new Error('Storage worker is unavailable');
    const id = ++this.nextId;
    const response = new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject }),
    );
    this.worker.postMessage({ id, command, args });
    return response;
  }

  async stop() {
    if (this.stopped) return;
    await this.ready.catch(() => {});
    await Promise.race([
      this.invoke('__close').catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
    this.stopped = true;
    const error = new Error('Storage worker stopped');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    await this.worker.terminate().catch(() => {});
  }
}
