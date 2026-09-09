// electron-updater may reuse a cached download without a download-progress event.
// Preserve the plugin callback ordering, including that zero-progress case.
import type { AppUpdater, ProgressInfo } from 'electron-updater';

export type UpdateProgress =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };
export type DownloadUpdater = Pick<AppUpdater, 'downloadUpdate'> & {
  on(event: 'download-progress', listener: (info: ProgressInfo) => void): unknown;
  removeListener(event: 'download-progress', listener: (info: ProgressInfo) => void): unknown;
};
export type InstallUpdater = Pick<AppUpdater, 'quitAndInstall' | 'autoRunAppAfterInstall'> & {
  once?(event: 'error', listener: (error: unknown) => void): unknown;
  removeListener?(event: 'error', listener: (error: unknown) => void): unknown;
};
async function downloadUpdate(updater: DownloadUpdater, send: (progress: UpdateProgress) => void) {
  let received = 0;
  let started = false;
  const start = (contentLength?: number) => {
    if (started) return;
    started = true;
    send({ event: 'Started', data: { contentLength } });
  };
  const progress = (info: ProgressInfo) => {
    start(info.total);
    const chunkLength = Math.max(0, info.transferred - received);
    received = info.transferred;
    send({ event: 'Progress', data: { chunkLength } });
  };
  updater.on('download-progress', progress);
  try {
    await updater.downloadUpdate();
    start();
    send({ event: 'Finished' });
  } finally {
    updater.removeListener('download-progress', progress);
  }
}
function installDownloadedUpdate(
  updater: InstallUpdater,
  restart: boolean,
  onFailure: (error: Error) => void = () => {},
) {
  let failed = false;
  const failure = (error: unknown) => {
    if (failed) return;
    failed = true;
    onFailure(error instanceof Error ? error : new Error(String(error)));
  };
  updater.once?.('error', failure);
  // MacUpdater ignores quitAndInstall arguments and reads this property instead.
  updater.autoRunAppAfterInstall = restart;
  try {
    updater.quitAndInstall(false, restart);
  } catch (error) {
    updater.removeListener?.('error', failure);
    failure(error);
  }
}
export { downloadUpdate, installDownloadedUpdate };
