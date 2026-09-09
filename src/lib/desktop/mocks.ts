// Test/browser fixture adapter. This module is not imported by the application.
import commands from '../../../electron/commands.json';
import type { DesktopBridge } from './core';

const callbacks = new Map<string, Set<(payload: unknown) => void>>();
export function mockIPC(
  handler: (command: string, args: Record<string, unknown>) => unknown | Promise<unknown>,
  _options?: { shouldMockEvents?: boolean },
): void {
  const bridge: DesktopBridge = {
    migrationRead: async () => null,
    commands: Object.fromEntries(
      commands.map((command) => [
        command,
        async (args: Record<string, unknown> = {}) => {
          try {
            return { ok: true as const, value: await handler(command, args) };
          } catch (error) {
            return { ok: false as const, error };
          }
        },
      ]),
    ) as unknown as DesktopBridge['commands'],
    on(event, callback) {
      if (!callbacks.has(event)) callbacks.set(event, new Set());
      callbacks.get(event)!.add(callback as (payload: unknown) => void);
      return () => {
        callbacks.get(event)?.delete(callback as (payload: unknown) => void);
      };
    },
    window: (async (action: string) =>
      action === 'isMaximized' ? false : undefined) as DesktopBridge['window'],
    version: async () => '2.0.56',
    filePath: () => '',
    log: async () => undefined,
    update: (async (action: string) =>
      action === 'check' ? null : undefined) as DesktopBridge['update'],
  };
  window.shellspan = bridge;
}
export function clearMocks(): void {
  delete window.shellspan;
  callbacks.clear();
}
export async function emit(event: string, payload: unknown): Promise<void> {
  for (const callback of callbacks.get(event) ?? []) callback(payload);
}
