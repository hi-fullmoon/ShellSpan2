import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NodeCoreEventSender } from './events.ts';

type PetdexStatus = 'notDetected' | 'connected' | 'notRunning' | 'connectionError';

export class PetdexAdapter {
  private enabled = false;
  private status: PetdexStatus = 'notDetected';
  private request?: AbortController;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sshConnecting = new Set<string>();
  private readonly sftpActive = new Set<string>();

  constructor(
    private readonly home: string,
    private readonly events: NodeCoreEventSender,
    private readonly endpoint = 'http://127.0.0.1:7777/state',
  ) {}

  getStatus() {
    return this.status;
  }

  setEnabled(enabled: boolean) {
    if (enabled && this.enabled) return this.status;
    if (!enabled) this.request?.abort();
    this.enabled = enabled;
    this.update('notDetected', true);
    if (enabled) void this.queueSend('idle');
    return this.status;
  }

  async testConnection() {
    if (!this.enabled) return 'notDetected' as const;
    return this.queueSend('waving', 1200);
  }

  notify(kind: string, operationId: string) {
    if (!this.enabled) return null;
    switch (kind) {
      case 'ssh-connecting':
        this.sshConnecting.add(operationId);
        void this.queueSend('waiting');
        break;
      case 'ssh-connected':
        this.sshConnecting.delete(operationId);
        void this.queueSend('waving', 1200);
        break;
      case 'ssh-failed':
        this.sshConnecting.delete(operationId);
        void this.queueSend('failed', 2500);
        break;
      case 'ssh-closed':
        this.sshConnecting.delete(operationId);
        void this.queuePersistent();
        break;
      case 'sftp-started':
        this.sftpActive.add(operationId);
        void this.queueSend('running');
        break;
      case 'sftp-succeeded':
        this.sftpActive.delete(operationId);
        void this.queueSend('jumping', 1200);
        break;
      case 'sftp-failed':
        this.sftpActive.delete(operationId);
        void this.queueSend('failed', 2500);
        break;
      case 'sftp-cancelled':
        this.sftpActive.delete(operationId);
        void this.queuePersistent();
        break;
    }
    return null;
  }

  stop() {
    this.enabled = false;
    this.request?.abort();
    this.request = undefined;
  }

  private update(status: PetdexStatus, force = false) {
    if (force || status !== this.status) {
      this.status = status;
      void this.events.emit('petdex-status', status);
    }
  }

  private async token(): Promise<{ token?: string; status?: PetdexStatus }> {
    try {
      const token = (
        await readFile(join(this.home, '.petdex/runtime/update-token'), 'utf8')
      ).trim();
      return /^[a-f\d]{64}$/i.test(token) ? { token } : { status: 'connectionError' };
    } catch (error) {
      return {
        status:
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'notDetected' : 'connectionError',
      };
    }
  }

  private queueSend(state: string, duration?: number) {
    const task = this.queue.then(() => this.send(state, duration));
    this.queue = task.catch(() => {});
    return task;
  }

  private queuePersistent() {
    return this.queueSend(
      this.sftpActive.size ? 'running' : this.sshConnecting.size ? 'waiting' : 'idle',
    );
  }

  private async send(state: string, duration?: number): Promise<PetdexStatus> {
    if (!this.enabled) return this.updateAndReturn('notDetected');
    const tokenResult = await this.token();
    if (!this.enabled) return this.updateAndReturn('notDetected');
    if (!tokenResult.token) return this.updateAndReturn(tokenResult.status || 'connectionError');
    const token = tokenResult.token;
    const controller = new AbortController();
    this.request = controller;
    const timeout = setTimeout(() => controller.abort(), 750);
    try {
      const post = (authorization: string) =>
        fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            connection: 'close',
            'x-petdex-update-token': authorization,
          },
          body: JSON.stringify({ state, ...(duration === undefined ? {} : { duration }) }),
          signal: controller.signal,
        });
      let response = await post(token);
      if (response.status === 401) {
        const refreshed = await this.token();
        if (refreshed.token && refreshed.token !== token) response = await post(refreshed.token);
      }
      return this.updateAndReturn(response.status === 200 ? 'connected' : 'connectionError');
    } catch {
      return this.updateAndReturn(this.enabled ? 'notRunning' : 'notDetected');
    } finally {
      clearTimeout(timeout);
      if (this.request === controller) this.request = undefined;
    }
  }

  private updateAndReturn(status: PetdexStatus) {
    this.update(status);
    return status;
  }
}
