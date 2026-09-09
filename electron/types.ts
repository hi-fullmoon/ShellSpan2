/** Records exchanged with the local Rust core over the framed IPC channels. */
export type NativeResponse = { ok: true; value: unknown } | { ok: false; error: unknown };

export interface NativeReady {
  type: 'ready';
  protocol: number;
  terminalChannel: boolean;
}

export type NativeMessage =
  | NativeReady
  | { type: 'initializing'; protocol: number; phase: string; sequence: number }
  | ({ type: 'response'; id: number } & NativeResponse)
  | { type: 'event'; event: string; payload: unknown; terminalSeq?: number }
  | { type: 'log'; level: string; message: string; target?: string }
  | { type: 'stopped' };
