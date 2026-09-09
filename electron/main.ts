import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  dialog,
  shell,
  session,
  protocol,
} from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isRendererEvent } from './events.ts';
import { trustedURL, verifySender } from './security.ts';
import { fontResponse } from './fonts.ts';
import { NativeHost } from './native.ts';
import { TerminalFlow } from './terminal-flow.ts';
import { validateCommand } from './validation.ts';
import { createLogs } from './logs.ts';
import { autoUpdater } from 'electron-updater';
import { downloadUpdate, installDownloadedUpdate } from './update-download.ts';
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  PermissionCheckHandlerHandlerDetails,
  PermissionRequest,
} from 'electron';
import type { UpdateInfo } from 'electron-updater';

let win: BrowserWindow;
let tray: Tray;
let core: NativeHost;
let terminalFlow: TerminalFlow;
let logs: ReturnType<typeof createLogs>;
let quitting = false;
let stopping: Promise<void> | undefined;
let downloaded = false;
const devURL = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
if (devURL && !/^http:\/\/localhost:1420\/?$/.test(devURL))
  throw new Error('Invalid development server');
const entry = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'shellspan-font',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
app.setName('ShellSpan');
// Match WKWebView's preferred system language even though B's native bundle
// resources are English-only. Keep an explicit command-line override intact.
if (process.platform === 'darwin' && !app.commandLine.hasSwitch('lang')) {
  const preferred = app.getPreferredSystemLanguages()[0];
  if (preferred) {
    const locale = new Intl.Locale(preferred);
    app.commandLine.appendSwitch(
      'lang',
      [locale.language, locale.region].filter(Boolean).join('-'),
    );
  }
}
// Preserve native Tauri directories. Chromium storage has its own container.
const legacyData =
  process.platform === 'linux'
    ? path.join(
        process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'),
        'com.shellspan',
      )
    : path.join(app.getPath('appData'), 'com.shellspan');
const legacyLogs =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Logs/com.shellspan')
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'com.shellspan/logs')
      : path.join(legacyData, 'logs');
const appData = process.env.SHELLSPAN_APP_DATA || legacyData;
const logDir = process.env.SHELLSPAN_LOG_DIR || legacyLogs;
app.setPath(
  'userData',
  process.env.SHELLSPAN_CHROMIUM_DATA || path.join(appData, 'electron-webview'),
);
function send(event: string, payload: unknown = null) {
  if (win && !win.isDestroyed()) win.webContents.send('desktop:event', event, payload);
}
function verify(event: IpcMainEvent | IpcMainInvokeEvent) {
  verifySender(event, win, entry, devURL);
}

async function stop() {
  if (!stopping)
    stopping = (async () => {
      await core?.stop();
      await logs?.flush();
    })();
  return stopping;
}
async function quit(restart = false) {
  if (quitting) return;
  quitting = true;
  await stop();
  if (downloaded)
    installDownloadedUpdate(autoUpdater, restart, (error) => {
      downloaded = false;
      console.error('Update installation failed', error);
      void Promise.resolve(
        logs?.write('backend', 'error', `Update installation failed: ${error.message}`),
      ).finally(() => {
        if (restart) app.relaunch();
        app.exit(1);
      });
    });
  else {
    if (restart) app.relaunch();
    app.quit();
  }
}
// B fails construction through Rust's existing error/panic path, without an
// additional application dialog. A fatal host failure must not install updates.
async function fatal(error: unknown) {
  if (quitting) return;
  quitting = true;
  console.error(error);
  await logs?.write('backend', 'error', error instanceof Error ? error.message : String(error));
  await stop();
  app.exit(1);
}
// Match rfd's macOS message while retaining parent-window modality.
const dialogTitle = (title: string) =>
  process.platform === 'darwin' ? { message: title } : { title };
const portable = (value: string) => value.replaceAll('\\', '/');
type NativeDesktopRequest =
  | { command: 'pick_local_files' | 'pick_private_key_file'; args: object }
  | { command: 'pick_local_folder'; args: { title?: string | null } }
  | { command: 'export_log_file'; args: { name: string; content: string } };

async function desktopCommand({ command, args }: NativeDesktopRequest) {
  switch (command) {
    case 'pick_local_files': {
      const result = await dialog.showOpenDialog(win, {
        ...dialogTitle('选择要上传的文件'),
        properties: ['openFile', 'multiSelections'],
      });
      return result.canceled ? [] : result.filePaths.map(portable);
    }
    case 'pick_local_folder': {
      const result = await dialog.showOpenDialog(win, {
        ...dialogTitle(args.title ?? '选择文件夹'),
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? [] : result.filePaths.map(portable);
    }
    case 'pick_private_key_file': {
      const result = await dialog.showOpenDialog(win, {
        ...dialogTitle('选择私钥文件'),
        properties: ['openFile'],
      });
      return result.canceled ? null : portable(result.filePaths[0]);
    }
    case 'export_log_file': {
      const result = await dialog.showSaveDialog(win, {
        ...dialogTitle('导出日志'),
        defaultPath: args.name,
      });
      if (result.canceled || !result.filePath) return null;
      try {
        await fs.writeFile(result.filePath, args.content);
      } catch (error) {
        throw new Error(
          `failed to write log file: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return portable(result.filePath);
    }
    default:
      return undefined;
  }
}
function installIPC() {
  ipcMain.handle('desktop:migration-read', async (event, key, offset) => {
    verify(event);
    if (typeof key !== 'string' || key.length > 100 || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error('Invalid migration read');
    const result = await core.invoke('migration-read', { key, offset }, 'migration-read');
    if (!result.ok) throw new Error(String(result.error));
    return result.value;
  });
  ipcMain.on('desktop:terminal-ready', (event) => {
    try {
      verify(event);
    } catch {
      return;
    }
    terminalFlow?.ready();
  });
  ipcMain.on('desktop:terminal-ack', (event, id) => {
    try {
      verify(event);
    } catch {
      return;
    }
    terminalFlow?.ack(id);
  });
  const nativeDesktop = new Set([
    'pick_local_files',
    'pick_local_folder',
    'pick_private_key_file',
    'export_log_file',
  ]);
  ipcMain.handle('desktop:command', async (event, command, args = {}) => {
    verify(event);
    try {
      validateCommand(command, args);
      if (nativeDesktop.has(command)) {
        const validated = await core.validate(command, args);
        if (!validated.ok) return validated;
        // Rust Serde has validated the fields for this specific dialog command.
        return { ok: true, value: await desktopCommand({ command, args } as NativeDesktopRequest) };
      }
      const result = await core.invoke(command, args);
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : error };
    }
  });
  ipcMain.handle('desktop:window', (event, action) => {
    verify(event);
    switch (action) {
      case 'minimize':
        return win.minimize();
      case 'maximize':
        return win.maximize();
      case 'unmaximize':
        return win.unmaximize();
      case 'close':
        return win.close();
      case 'isMaximized':
        return win.isMaximized();
      default:
        throw new Error('Unknown window action');
    }
  });
  ipcMain.handle('desktop:version', (event) => {
    verify(event);
    return app.getVersion();
  });
  ipcMain.handle('desktop:log', (event, level, message) => {
    verify(event);
    if (
      !['debug', 'info', 'warn', 'error'].includes(level) ||
      typeof message !== 'string' ||
      message.length > 1024 * 1024
    )
      throw new Error('Invalid log record');
    return logs.write('frontend', level, message);
  });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('error', (error) => logs.write('backend', 'error', error.message));
  let updateInfo: UpdateInfo | null = null;
  let updateJob: Promise<void> | null = null;
  ipcMain.handle('desktop:update', async (event, action, version) => {
    verify(event);
    if (!app.isPackaged) throw new Error('Updates require a packaged application');
    if (action === 'check') {
      const result = await autoUpdater.checkForUpdates();
      updateInfo = result?.isUpdateAvailable ? result.updateInfo : null;
      return updateInfo
        ? {
            version: updateInfo.version,
            body: typeof updateInfo.releaseNotes === 'string' ? updateInfo.releaseNotes : undefined,
          }
        : null;
    }
    if (action !== 'download' || !updateInfo || version !== updateInfo.version)
      throw new Error('No matching update');
    if (!updateJob)
      updateJob = (async () => {
        try {
          await downloadUpdate(autoUpdater, (payload) => send('desktop-update-progress', payload));
          downloaded = true;
        } finally {
          updateJob = null;
        }
      })();
    await updateJob;
  });
}
function setupMenus() {
  const item = (label: string, event: string) => ({
    label,
    click: () => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      send(event);
    },
  });
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'ShellSpan',
          submenu: [
            item('About ShellSpan', 'system-about'),
            item('Settings...', 'system-open-settings'),
            item('Check for Updates...', 'system-check-update'),
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { type: 'separator' },
            item('Quit ShellSpan', 'system-request-app-exit'),
          ],
        },
        { label: 'File', submenu: [{ role: 'close' }] },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
        {
          role: 'windowMenu',
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'close' },
          ],
        },
        { label: 'Help', submenu: [] },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
    tray = new Tray(path.join(__dirname, '../native/icons/32x32.png'));
    tray.setToolTip('ShellSpan');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Show ShellSpan',
          click: () => {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          },
        },
        item('Settings', 'system-open-settings'),
        item('Check for Updates', 'system-check-update'),
        item('About', 'system-about'),
        item('Quit', 'system-request-app-exit'),
      ]),
    );
    tray.on('click', () => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault();
      send('system-request-app-exit');
    }
  });
  app.on('window-all-closed', () => {});
  app.on('activate', () => {
    if (win) win.show();
  });
  app
    .whenReady()
    .then(async () => {
      protocol.handle('shellspan-font', (request) => fontResponse(request));
      await fs.mkdir(appData, { recursive: true });
      logs = createLogs(logDir);
      const binary = app.isPackaged
        ? path.join(
            process.resourcesPath,
            'native',
            process.platform === 'win32' ? 'shellspan-core.exe' : 'shellspan-core',
          )
        : path.join(
            __dirname,
            '../native/target/debug',
            process.platform === 'win32' ? 'shellspan-core.exe' : 'shellspan-core',
          );
      core = new NativeHost(binary, {
        ...process.env,
        SHELLSPAN_APP_DATA: appData,
        SHELLSPAN_LOG_DIR: logDir,
      });
      terminalFlow = new TerminalFlow(
        (event, payload, id) => {
          if (win && !win.isDestroyed() && !core.stopping)
            win.webContents.send('desktop:event', event, payload, id);
          else terminalFlow.ack(id);
        },
        () => core.terminalSocket?.pause(),
        () => core.terminalSocket?.resume(),
      );
      core.on('log', (record) =>
        logs.write('backend', record.level, record.message, record.target),
      );
      core.on('event', (event, payload) => {
        if (event === 'desktop-exit') void quit();
        else if (event === 'desktop-restart') void quit(true);
        else if (
          event.startsWith('ssh-data:') ||
          ['ssh-status', 'ssh-closed', 'ssh-session-error'].includes(event)
        )
          terminalFlow.push(event, payload);
        else if (isRendererEvent(event)) send(event, payload);
      });
      core.on('failure', (error) => logs.write('backend', 'error', error.message));
      core.on('exit', ({ expected }) => {
        if (!expected && win) void fatal(new Error('Native core stopped'));
      });
      installIPC();
      win = new BrowserWindow({
        title: process.platform === 'darwin' ? '' : 'ShellSpan',
        width: 1480,
        height: 920,
        minWidth: 1200,
        minHeight: 760,
        resizable: true,
        fullscreen: false,
        fullscreenable: true,
        transparent: true,
        show: false,
        ...(process.platform === 'darwin'
          ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 9, y: 9 } }
          : { frame: false }),
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
        },
      });
      win.on('close', (event) => {
        if (!quitting) {
          event.preventDefault();
          if (process.platform === 'darwin') send('system-request-app-exit');
          else win.hide();
        }
      });
      win.on('resize', () => send('desktop-resized'));
      win.on('maximize', () => send('desktop-resized'));
      win.on('unmaximize', () => send('desktop-resized'));
      win.webContents.on('did-start-navigation', (details) => {
        if (
          details.isMainFrame &&
          !details.isSameDocument &&
          trustedURL(details.url, entry, devURL)
        )
          terminalFlow.navigation();
      });
      win.webContents.on('render-process-gone', (_event, details) => {
        if (!quitting) void fatal(new Error(`Renderer stopped (${details.reason})`));
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
      });
      win.webContents.on('will-navigate', (event, url) => {
        if (!trustedURL(url, entry, devURL)) event.preventDefault();
      });
      const clipboardPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write']);
      const allowClipboard = (
        contents: WebContents | null,
        permission: string,
        details: PermissionCheckHandlerHandlerDetails | PermissionRequest,
      ) => {
        if (
          contents !== win.webContents ||
          !details.isMainFrame ||
          !clipboardPermissions.has(permission)
        )
          return false;
        const url =
          ('requestingUrl' in details ? details.requestingUrl : undefined) || contents.getURL();
        return trustedURL(url, entry, devURL);
      };
      session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
        allowClipboard(contents, permission, details),
      );
      session.defaultSession.setPermissionRequestHandler(
        (contents, permission, callback, details) =>
          callback(allowClipboard(contents, permission, details)),
      );
      setupMenus();
      await core.ready;
      await win.loadURL(devURL || entry);
      win.show();
    })
    .catch(fatal);
}
