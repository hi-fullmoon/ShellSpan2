import { prepareDesktopFonts } from './lib/desktop/fonts';
import { migrateLegacyStorage } from './lib/desktop/migrate-storage';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base.css';
import { App } from './App';
import { AppErrorBoundary, AppErrorFallback } from './components/app-error-boundary';
import { initGlobalErrorLogging } from './lib/logger';
import { applyTheme } from './lib/theme';
import { parseTerminalWorkspace } from './lib/terminal/terminal-workspace';
import { parseSftpWorkspace } from './lib/sftp/sftp-workspace';
import {
  invokeClearSftpWorkspace,
  invokeClearTerminalWorkspace,
  invokeLoadSftpWorkspace,
  invokeLoadTerminalWorkspace,
} from './lib/ipc/tauri';
import { useAppStore } from './stores/appStore';
import { useProfileStore } from './stores/profileStore';
import { useRecentProfilesStore } from './stores/recentProfilesStore';
import { useTerminalStore } from './stores/terminalStore';
import { useAiSettingsStore } from './stores/aiSettingsStore';
import { useSftpStore } from './stores/sftpStore';
import { hydrateTransferResumeCandidates } from './lib/sftp/transfer-resume';

initGlobalErrorLogging();

let root: ReturnType<typeof ReactDOM.createRoot> | undefined;
const appRoot = () => (root ??= ReactDOM.createRoot(document.getElementById('root')!));

async function bootstrap(): Promise<void> {
  await prepareDesktopFonts();
  await migrateLegacyStorage();
  await Promise.all([
    useAppStore.getState().hydrateFromDb(),
    useProfileStore.getState().hydrateFromDb(),
    useRecentProfilesStore.getState().hydrateFromDb(),
    useAiSettingsStore.getState().hydrateFromDb(),
  ]);
  if (useAppStore.getState().restoreWorkspace) {
    await Promise.all([
      invokeLoadTerminalWorkspace()
        .then((rawWorkspace) => {
          const workspace = parseTerminalWorkspace(rawWorkspace);
          useTerminalStore.getState().addRestoredSessions(workspace.sessions, workspace.layout);
        })
        .catch(() => {}),
      invokeLoadSftpWorkspace()
        .then((rawWorkspace) => {
          const workspace = parseSftpWorkspace(rawWorkspace);
          useSftpStore
            .getState()
            .addRestoredConnections(
              workspace.tabs,
              workspace.activeConnectionId,
              useProfileStore.getState().profiles,
            );
        })
        .catch(() => {}),
    ]);
  } else {
    await Promise.allSettled([invokeClearTerminalWorkspace(), invokeClearSftpWorkspace()]);
  }
  await hydrateTransferResumeCandidates().catch(() => {
    // Interrupted transfers are optional recovery metadata and never block startup.
  });
  applyTheme(useAppStore.getState().theme);

  appRoot().render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}

let starting = false;
async function start(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    await bootstrap();
  } catch (error) {
    console.error('Application initialization failed', error);
    appRoot().render(
      <AppErrorFallback
        error={error instanceof Error ? error : new Error(String(error))}
        onRetry={() => {
          void start();
        }}
        onReload={() => window.location.reload()}
      />,
    );
  } finally {
    starting = false;
  }
}
void start();
