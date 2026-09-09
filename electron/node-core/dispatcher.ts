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
import { llmCommands } from './llm-domain.ts';

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
  if (llmCommands.has(command)) {
    if (!context.state.llm) throw new Error('LLM backend is not active');
    return context.state.llm.command(command, args as Record<string, unknown>, context.signal);
  }
  switch (command) {
    case 'check_host_key': {
      if (!context.state.hostTrust) throw new Error('Host trust backend is not active');
      const request = (args as { request: { host: string; port: number } }).request;
      return context.state.hostTrust.check(request.host, request.port, context.signal);
    }
    case 'trust_host': {
      if (!context.state.hostTrust) throw new Error('Host trust backend is not active');
      const request = (
        args as { request: { host: string; port: number; expectedFingerprint: string } }
      ).request;
      return context.state.hostTrust.trust(request.host, request.port, request.expectedFingerprint);
    }
    case 'list_known_hosts':
      if (!context.state.hostTrust) throw new Error('Host trust backend is not active');
      return context.state.hostTrust.list();
    case 'remove_known_host':
      if (!context.state.hostTrust) throw new Error('Host trust backend is not active');
      return context.state.hostTrust.remove(
        (args as { host: string }).host,
        (args as { port: number }).port,
      );
    case 'preflight_connection':
      if (!context.state.preflight) throw new Error('Connection preflight backend is not active');
      return context.state.preflight.run((args as { request: never }).request);
    case 'cancel_connection_preflight':
      if (!context.state.preflight) throw new Error('Connection preflight backend is not active');
      return context.state.preflight.cancel((args as { operationId: string }).operationId);
    case 'warm_remote_connection':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.warm((args as { request: never }).request, context.signal);
    case 'disconnect_sftp':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.disconnect((args as { request: never }).request);
    case 'list_remote_directory':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.list((args as { request: never }).request);
    case 'supersede_remote_directory_request':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.supersede(
        (args as { requestKey: string }).requestKey,
        (args as { requestId: number }).requestId,
      );
    case 'create_remote_entry':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.create((args as { request: never }).request);
    case 'rename_remote_path':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.rename((args as { request: never }).request);
    case 'update_remote_permissions':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.chmod((args as { request: never }).request);
    case 'delete_remote_path':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.delete((args as { request: never }).request);
    case 'upload_local_paths':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.upload((args as { request: never }).request);
    case 'download_remote_paths':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.download((args as { request: never }).request);
    case 'preview_remote_file':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.preview((args as { request: never }).request);
    case 'open_remote_file':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.open((args as { request: never }).request);
    case 'copy_remote_path':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.copyRemote((args as { request: never }).request);
    case 'copy_remote_to_remote':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.copyRemoteToRemote((args as { request: never }).request);
    case 'resolve_remote_entry_owners':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.owners((args as { request: never }).request);
    case 'cancel_upload':
    case 'cancel_download':
    case 'cancel_delete':
    case 'cancel_remote_copy':
    case 'cancel_remote_file_read':
      if (!context.state.remoteFs) throw new Error('Remote filesystem backend is not active');
      return context.state.remoteFs.cancel(
        (args as { operationId: string }).operationId,
        command === 'cancel_upload'
          ? 'upload'
          : command === 'cancel_download'
            ? 'download'
            : command === 'cancel_delete'
              ? 'delete'
              : command === 'cancel_remote_copy'
                ? 'copy'
                : 'read',
      );
    case 'collect_remote_health_snapshot':
      if (!context.state.remoteHealth) throw new Error('Remote health backend is not active');
      return context.state.remoteHealth.collect((args as { request: never }).request);
    case 'cancel_remote_health_snapshot':
      if (!context.state.remoteHealth) throw new Error('Remote health backend is not active');
      return context.state.remoteHealth.cancel((args as { operationId: string }).operationId);
    case 'list_port_forwards':
      if (!context.state.portForwards) throw new Error('Port forward backend is not active');
      return context.state.portForwards.list();
    case 'start_port_forward':
      if (!context.state.portForwards) throw new Error('Port forward backend is not active');
      return context.state.portForwards.start((args as { request: never }).request);
    case 'stop_port_forward':
      if (!context.state.portForwards) throw new Error('Port forward backend is not active');
      return context.state.portForwards.stopOne((args as { operationId: string }).operationId);
    case 'stop_all_port_forwards':
      if (!context.state.portForwards) throw new Error('Port forward backend is not active');
      return context.state.portForwards.stopAll();
    case 'create_local_session':
      if (!context.state.terminal) throw new Error('Terminal backend is not active');
      return context.state.terminal.createLocal(
        (args as { cols: number }).cols,
        (args as { rows: number }).rows,
      );
    case 'create_session':
      if (!context.state.terminal) throw new Error('Terminal backend is not active');
      return context.state.terminal.createRemote(
        (args as { request: Parameters<typeof context.state.terminal.createRemote>[0] }).request,
        context.signal,
      );
    case 'get_session_status':
      if (!context.state.terminal) throw new Error('Terminal backend is not active');
      return context.state.terminal.getStatus((args as { sessionId: string }).sessionId);
    case 'mark_session_ready':
      if (!context.state.terminal) throw new Error('Terminal backend is not active');
      return context.state.terminal.markReady((args as { sessionId: string }).sessionId);
    case 'set_session_output_paused':
      if (!context.state.terminal) throw new Error('Terminal backend is not active');
      return context.state.terminal.setPaused(
        (args as { sessionId: string }).sessionId,
        (args as { paused: boolean }).paused,
      );
    case 'write_session':
      if (!context.state.terminal) throw new Error('Terminal backend is not active');
      return context.state.terminal.write(
        (args as { sessionId: string }).sessionId,
        (args as { data: string }).data,
      );
    case 'resize_session':
      if (!context.state.terminal) throw new Error('Terminal backend is not active');
      return context.state.terminal.resize(
        (args as { sessionId: string }).sessionId,
        (args as { cols: number }).cols,
        (args as { rows: number }).rows,
      );
    case 'close_session':
      if (!context.state.terminal) throw new Error('Terminal backend is not active');
      return context.state.terminal.close((args as { sessionId: string }).sessionId);
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
