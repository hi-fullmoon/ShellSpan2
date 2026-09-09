/** Records exchanged with an isolated core over the framed IPC channels. */
export type CoreResponse = { ok: true; value: unknown } | { ok: false; error: unknown };

export interface CoreReady {
  type: 'ready';
  protocol: number;
  terminalChannel: boolean;
}

export type CoreMessage =
  | CoreReady
  | { type: 'initializing'; protocol: number; phase: string; sequence: number }
  | ({ type: 'response'; id: number } & CoreResponse)
  | { type: 'event'; event: string; payload: unknown; terminalSeq?: number }
  | { type: 'log'; level: string; message: string; target?: string }
  | { type: 'stopped' };

// Kept as aliases while the Rust transport remains part of the migration.
export type NativeResponse = CoreResponse;
export type NativeReady = CoreReady;
export type NativeMessage = CoreMessage;
