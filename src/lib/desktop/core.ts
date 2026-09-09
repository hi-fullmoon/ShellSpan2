import type { DesktopCommand, DesktopEvent } from './contract';
import type { CommandInput, CommandValues, WireValue } from './command-types';
import type { DesktopPayload } from './event-types';

export type DesktopResult<T = unknown> = { ok: true; value: T } | { ok: false; error: unknown };
export interface DesktopBridge {
  commands: {
    [C in DesktopCommand]: (
      ...input: CommandInput<C>
    ) => Promise<DesktopResult<WireValue<CommandValues[C]>>>;
  };
  on: <E extends DesktopEvent>(
    event: E,
    callback: (payload: DesktopPayload<E>) => void,
  ) => () => void;
  window: {
    (action: 'isMaximized'): Promise<boolean>;
    (action: 'minimize' | 'maximize' | 'unmaximize' | 'close'): Promise<void>;
  };
  migrationRead: (
    key: string,
    offset: number,
  ) => Promise<{ text: string; next: number; done: boolean } | null>;
  version: () => Promise<string>;
  filePath: (file: File) => string;
  log: (level: string, message: string) => Promise<void>;
  update: {
    (action: 'check'): Promise<{ version: string; body?: string } | null>;
    (action: 'download', version: string): Promise<void>;
  };
}
declare global {
  interface Window {
    shellspan?: DesktopBridge;
  }
}
export function desktop(): DesktopBridge {
  if (!window.shellspan) throw new Error('ShellSpan desktop runtime is unavailable');
  return window.shellspan;
}
export async function invoke<T>(
  command: DesktopCommand,
  args?: Record<string, unknown>,
): Promise<T> {
  // The generic logging/hot-path wrappers share one transport seam. The public
  // preload methods themselves retain their per-command args and wire values.
  const method = desktop().commands[command] as (
    args?: Record<string, unknown>,
  ) => Promise<DesktopResult>;
  if (
    !Object.prototype.hasOwnProperty.call(desktop().commands, command) ||
    typeof method !== 'function'
  )
    throw new Error(`Unknown desktop command: ${command}`);
  const result = await method(args);
  if (!result.ok) throw result.error;
  return result.value as T;
}
