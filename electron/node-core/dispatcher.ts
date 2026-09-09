import { readFile } from 'node:fs/promises';
import { validateCommand } from '../validation.ts';
import {
  copyLocalPaths,
  listLocalDirectory,
  openPath,
  pasteLocalPaths,
  previewLocalFile,
  renameLocalPath,
  trashLocalPaths,
} from './local-fs.ts';
import { listLogFiles, readLogFile } from './log-domain.ts';
import { rustIoDetail } from './errors.ts';
import { expandHomePath } from './paths.ts';
import { credentialCommands } from './credentials.ts';
import type { NodeCoreEventSender } from './events.ts';
import type { NodeCoreState } from './state.ts';

export type NodeCoreContext = {
  state: NodeCoreState;
  events: NodeCoreEventSender;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
};

const storageCommands = new Set([
  'add_profile',
  'add_sftp_bookmark',
  'clear_sftp_workspace',
  'clear_terminal_workspace',
  'list_profiles',
  'list_recent_profiles',
  'list_sftp_bookmarks',
  'load_preferences',
  'load_sftp_workspace',
  'load_terminal_workspace',
  'remove_profile',
  'remove_recent_profile',
  'remove_sftp_bookmark',
  'save_preferences',
  'save_sftp_workspace',
  'save_terminal_workspace',
  'touch_recent_profile',
  'update_profile',
]);

async function readTextFile(args: object, home: string) {
  const file = expandHomePath((args as { path: string }).path, home);
  try {
    const bytes = await readFile(file);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('stream did not contain valid UTF-8');
    }
  } catch (error) {
    throw new Error(`failed to read file ${file}: ${rustIoDetail(error)}`);
  }
}

/** Stage 1 dispatcher: only the deterministic, read-only canary is implemented. */
export async function dispatchNodeCommand(command: string, args: object, context: NodeCoreContext) {
  if (command === '__petdex_notify') {
    const input = args as { kind: string; operationId: string };
    return context.state.petdex?.notify(input.kind, input.operationId) ?? null;
  }
  if (context.env.SHELLSPAN_NODE_CORE_TEST_MODE === '1') {
    if (command === '__test_event') {
      await context.events.emit('desktop-resized', null);
      return null;
    }
    if (command === '__test_crash') {
      setImmediate(() => {
        throw new Error('injected Node core crash');
      });
      return new Promise<never>(() => {});
    }
    if (command === '__test_cancel_local')
      return context.state.localOperations.cancel((args as { operationId: string }).operationId);
    if (command === '__test_credential_seed') {
      const input = args as { service: string; account: string; value: string };
      await context.state.credentials?.testSeedLegacy(input.service, input.account, input.value);
      return null;
    }
    if (command === '__test_credential_get') {
      const input = args as { service: string; account: string };
      return (await context.state.credentials?.testRead(input.service, input.account)) ?? null;
    }
    if (command === '__test_credential_raw_get') {
      const input = args as { service: string; account: string };
      return (await context.state.credentials?.testRawRead(input.service, input.account)) ?? null;
    }
    if (command === '__test_storage') {
      const input = args as { command: string; args?: Record<string, unknown> };
      if (!context.state.storage) throw new Error('Storage backend is not active');
      return context.state.storage.invoke(input.command, input.args || {});
    }
  }
  validateCommand(command, args);
  if (storageCommands.has(command)) {
    if (!context.state.storage) throw new Error('Storage backend is not active');
    return context.state.storage.invoke(command, args as Record<string, unknown>);
  }
  if (credentialCommands.has(command)) {
    if (!context.state.credentials) throw new Error('Credential backend is not active');
    return context.state.credentials.command(command, args as Record<string, unknown>);
  }
  switch (command) {
    case 'read_text_file':
      return readTextFile(args, context.state.paths.home);
    case 'preview_local_file':
      return previewLocalFile((args as { path: string }).path);
    case 'list_local_directory':
      return listLocalDirectory((args as { path: string }).path, context.state.paths.home);
    case 'copy_local_paths':
      return copyLocalPaths(
        (args as { request: Parameters<typeof copyLocalPaths>[0] }).request,
        context.state.localOperations,
      );
    case 'paste_local_paths': {
      const input = args as {
        sourcePaths: string[];
        destinationDirectory: string;
        copySuffix: string;
      };
      return pasteLocalPaths(
        input.sourcePaths,
        input.destinationDirectory,
        input.copySuffix,
        context.signal,
      );
    }
    case 'rename_local_path': {
      const input = args as { path: string; newName: string };
      return renameLocalPath(input.path, input.newName);
    }
    case 'trash_local_paths':
      return trashLocalPaths(
        (args as { paths: string[] }).paths,
        context.signal,
        context.env.SHELLSPAN_NODE_CORE_TEST_TRASH,
      );
    case 'open_path':
      return openPath(
        (args as { path: string }).path,
        context.env.SHELLSPAN_NODE_CORE_TEST_MODE === '1',
      );
    case 'list_log_files':
      return listLogFiles(context.state.paths.logs);
    case 'read_log_file':
      return readLogFile(context.state.paths.logs, (args as { name: string }).name);
    case 'get_system_health':
      return context.state.health.collect(
        context.state.paths.appData,
        context.env.SHELLSPAN_APP_VERSION || '0.0.0',
      );
    case 'petdex_get_status':
      return context.state.petdex?.getStatus() ?? 'connectionError';
    case 'petdex_set_enabled':
      return (
        context.state.petdex?.setEnabled((args as { enabled: boolean }).enabled) ??
        'connectionError'
      );
    case 'petdex_test_connection':
      return context.state.petdex?.testConnection() ?? 'connectionError';
  }
  throw new Error(`Command ${command} is not implemented by Node core`);
}
