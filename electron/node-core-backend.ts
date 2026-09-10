import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { CoreProcessHost } from './core-process.ts';
import type { CoreBackend, CoreBackendEvents, CoreRequestType } from './core-backend.ts';
import type { CoreResponse } from './types.ts';

/** Host adapter for the standalone Node Core protocol-v1 process. */
export class NodeCoreBackend extends EventEmitter<CoreBackendEvents> implements CoreBackend {
  readonly kind = 'node' as const;
  readonly host: CoreProcessHost;

  constructor(env: NodeJS.ProcessEnv, entry = path.join(__dirname, 'node-core/entry.js')) {
    super();
    this.host = new CoreProcessHost(process.execPath, { ...env, ELECTRON_RUN_AS_NODE: '1' }, [
      entry,
    ]);
    for (const event of ['log', 'event', 'initializing', 'stopped', 'exit', 'failure'] as const)
      this.host.on(event, (...args: CoreBackendEvents[typeof event]) => this.emit(event, ...args));
  }

  get ready() {
    return this.host.ready;
  }
  get stopping() {
    return this.host.stopping;
  }
  invoke(command: string, args: object = {}, type: CoreRequestType = 'request') {
    return this.host.invoke(command, args, type) as Promise<CoreResponse>;
  }
  validate(command: string, args: object = {}) {
    return this.host.validate(command, args) as Promise<CoreResponse>;
  }
  stop() {
    return this.host.stop();
  }
  pauseTerminalEvents() {
    this.host.terminalSocket?.pause();
  }
  resumeTerminalEvents() {
    this.host.terminalSocket?.resume();
  }
}
