import { contextBridge, ipcRenderer, webUtils } from 'electron';
import commands from './commands.json';
import { isRendererEvent } from './events.ts';

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
ipcRenderer.on('desktop:event', (_event, name: string, payload: unknown, terminalId?: number) => {
  const callbacks = listeners.get(name);
  if (callbacks)
    for (const callback of [...callbacks]) {
      try {
        callback(payload);
      } catch (error) {
        console.error(error);
      }
    }
  if (terminalId !== undefined) ipcRenderer.send('desktop:terminal-ack', terminalId);
});
globalThis.addEventListener?.(
  'DOMContentLoaded',
  () => ipcRenderer.send('desktop:terminal-ready'),
  { once: true },
);

const bridge = {
  commands: Object.fromEntries(
    commands.map((command) => [
      command,
      (args: object = {}) => ipcRenderer.invoke('desktop:command', command, args),
    ]),
  ),
  on(name: string, callback: Listener) {
    if (!isRendererEvent(name) || typeof callback !== 'function')
      throw new Error('Invalid event subscription');
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(callback);
    return () => {
      const set = listeners.get(name);
      set?.delete(callback);
      if (set?.size === 0) listeners.delete(name);
    };
  },
  window: (action: 'minimize' | 'maximize' | 'unmaximize' | 'close' | 'isMaximized') =>
    ipcRenderer.invoke('desktop:window', action),
  migrationRead: (key: string, offset: number) =>
    ipcRenderer.invoke('desktop:migration-read', key, offset),
  version: () => ipcRenderer.invoke('desktop:version'),
  filePath: (file: File) => webUtils.getPathForFile(file),
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
    ipcRenderer.invoke('desktop:log', level, message),
  update: (action: 'check' | 'download', version?: string) =>
    ipcRenderer.invoke('desktop:update', action, version),
};

export type PreloadBridge = typeof bridge;
contextBridge.exposeInMainWorld('shellspan', bridge);
