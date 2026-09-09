import { desktop } from './core';

export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };
export interface Update {
  version: string;
  body?: string;
  downloadAndInstall: (callback: (event: DownloadEvent) => void) => Promise<void>;
}
export async function check(): Promise<Update | null> {
  const info = (await desktop().update('check')) as { version: string; body?: string } | null;
  if (!info) return null;
  return {
    ...info,
    async downloadAndInstall(callback) {
      const stop = desktop().on('desktop-update-progress', (payload) =>
        callback(payload as DownloadEvent),
      );
      try {
        await desktop().update('download', info.version);
      } finally {
        stop();
      }
    },
  };
}
