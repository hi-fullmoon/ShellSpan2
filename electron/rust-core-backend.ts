import { EventEmitter } from 'node:events';
import { NativeHost } from './native.ts';
import type { CoreBackend, CoreBackendEvents, CoreRequestType } from './core-backend.ts';
import type { CoreResponse } from './types.ts';

/** Adapts the existing Rust NativeHost without changing its transport semantics. */
export class RustCoreBackend extends EventEmitter<CoreBackendEvents> implements CoreBackend {
  readonly kind = 'rust' as const;
  readonly host: NativeHost;

  constructor(binary: string, env: NodeJS.ProcessEnv) {
    super();
    this.host = new NativeHost(binary, env);
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
