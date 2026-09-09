import type { EventEmitter } from 'node:events';
import type { CoreReady, CoreResponse } from './types.ts';

export type BackendKind = 'rust' | 'node';
export type CoreRequestType = 'request' | 'migration-read';
export type CoreExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
};
export type CoreLogRecord = { level: string; message: string; target?: string };
export type CoreBackendEvents = {
  log: [record: CoreLogRecord];
  event: [event: string, payload: unknown];
  initializing: [progress: { phase: string; sequence: number }];
  stopped: [];
  exit: [info: CoreExitInfo];
  failure: [error: Error];
};

/** Stable Electron-to-Core boundary used by both migration backends. */
export interface CoreBackend {
  readonly kind: BackendKind | 'router';
  readonly ready: Promise<CoreReady>;
  readonly stopping: boolean;
  invoke(command: string, args?: object, type?: CoreRequestType): Promise<CoreResponse>;
  validate(command: string, args?: object): Promise<CoreResponse>;
  stop(): Promise<void>;
  pauseTerminalEvents(): void;
  resumeTerminalEvents(): void;
  on: EventEmitter<CoreBackendEvents>['on'];
}
