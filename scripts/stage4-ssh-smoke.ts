import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:net';
import * as assert from 'node:assert/strict';
import type { NodeCoreBackend as NodeCoreBackendType } from '../electron/node-core-backend.ts';

const require = createRequire(import.meta.url);
const { NodeCoreBackend } = require('../dist-electron/node-core-backend.js') as {
  NodeCoreBackend: typeof NodeCoreBackendType;
};

const host = process.env.SHELLSPAN_E2E_SSH_HOST || '127.0.0.1';
const port = Number(process.env.SHELLSPAN_E2E_SSH_PORT || 22222);
const jumpPort = Number(process.env.SHELLSPAN_E2E_SSH_JUMP_PORT || 22223);
const username = process.env.SHELLSPAN_E2E_SSH_USERNAME || 'shellspan';
const password = process.env.SHELLSPAN_E2E_SSH_PASSWORD || 'shellspan-e2e';
const root = await mkdtemp(join(tmpdir(), 'shellspan-stage4-ssh-'));
const backend = new NodeCoreBackend({
  ...process.env,
  SHELLSPAN_HOME: root,
  SHELLSPAN_APP_DATA: join(root, 'app'),
  SHELLSPAN_LOG_DIR: join(root, 'logs'),
  SHELLSPAN_CREDENTIAL_TEST_MODE: '1',
});

async function value(command: string, args: object = {}) {
  const result = await backend.invoke(command, args);
  if (!result.ok) throw new Error(`${command}: ${String(result.error)}`);
  return result.value;
}

const connection = {
  host,
  port,
  username,
  authMethod: 'password' as const,
  password,
};

try {
  await backend.ready;
  const first = (await value('check_host_key', {
    request: { host, port },
  })) as { status: string; fingerprint: string };
  assert.equal(first.status, 'notFound');
  const untrustedPreflight = (await value('preflight_connection', {
    request: {
      ...connection,
      password: 'must-not-be-sent-before-trust',
      operationId: 'stage4-untrusted-preflight',
    },
  })) as { status: string; steps: Array<{ id: string; status: string }> };
  assert.equal(untrustedPreflight.status, 'attention');
  assert.equal(
    untrustedPreflight.steps.find((step) => step.id === 'authentication')?.status,
    'blocked',
  );
  await value('trust_host', {
    request: { host, port, expectedFingerprint: first.fingerprint },
  });
  assert.equal(
    ((await value('check_host_key', { request: { host, port } })) as { status: string }).status,
    'match',
  );

  const jumpFirst = (await value('check_host_key', {
    request: { host, port: jumpPort },
  })) as { status: string; fingerprint: string };
  assert.equal(jumpFirst.status, 'notFound');
  await value('trust_host', {
    request: { host, port: jumpPort, expectedFingerprint: jumpFirst.fingerprint },
  });

  const knownHostsPath = join(root, '.shellspan-dev', 'known_hosts');
  const knownHostLines = (await readFile(knownHostsPath, 'utf8')).trim().split('\n');
  const directLine = knownHostLines.find((line) => line.startsWith(`[${host}]:${port} `));
  const jumpLine = knownHostLines.find((line) => line.startsWith(`[${host}]:${jumpPort} `));
  assert.ok(directLine && jumpLine);
  await writeFile(
    knownHostsPath,
    `${jumpLine.replace(`[${host}]:${jumpPort}`, `[${host}]:${port}`)}\n${jumpLine}\n`,
  );
  assert.equal(
    ((await value('check_host_key', { request: { host, port } })) as { status: string }).status,
    'mismatch',
  );
  await value('trust_host', {
    request: { host, port, expectedFingerprint: first.fingerprint },
  });

  const preflight = (await value('preflight_connection', {
    request: { ...connection, operationId: 'stage4-preflight' },
  })) as { status: string };
  assert.equal(preflight.status, 'passed', JSON.stringify(preflight));

  const badAuth = await backend.invoke('create_session', {
    request: { ...connection, password: 'intentionally-wrong', name: 'bad auth' },
  });
  assert.equal(badAuth.ok, false);

  let terminalOutput = '';
  backend.on('event', (event, payload) => {
    if (event.startsWith('ssh-data:')) terminalOutput += String(payload);
  });
  const session = (await value('create_session', {
    request: {
      ...connection,
      name: 'Node SSH fixture',
      terminalCols: 80,
      terminalRows: 24,
    },
  })) as { sessionId: string };
  await value('mark_session_ready', { sessionId: session.sessionId });
  await value('write_session', {
    sessionId: session.sessionId,
    data: "printf 'NODE_SSH_%s\\n' 'OK'\n",
  });
  const deadline = Date.now() + 5000;
  while (!terminalOutput.includes('NODE_SSH_OK') && Date.now() < deadline)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.match(terminalOutput, /NODE_SSH_OK/);
  await value('close_session', { sessionId: session.sessionId });

  const listing = (await value('list_remote_directory', {
    request: { ...connection, path: '/home/shellspan', requestKey: 'stage4', requestId: 1 },
  })) as { entries: unknown[] };
  assert.ok(Array.isArray(listing.entries));

  const targetKnownHost = directLine.replace(`[${host}]:${port}`, 'ssh');
  await writeFile(knownHostsPath, `${await readFile(knownHostsPath, 'utf8')}${targetKnownHost}\n`);
  const jumpConnection = {
    host: 'ssh',
    port: 22,
    username,
    authMethod: 'password' as const,
    password,
    jumpHost: {
      host,
      port: jumpPort,
      username,
      authMethod: 'password' as const,
      password,
    },
  };
  const jumpListing = (await value('list_remote_directory', {
    request: { ...jumpConnection, path: '/home/shellspan', requestKey: 'jump', requestId: 1 },
  })) as { entries: unknown[] };
  assert.ok(Array.isArray(jumpListing.entries));
  const jumpPreflight = (await value('preflight_connection', {
    request: { ...jumpConnection, operationId: 'stage4-jump-preflight' },
  })) as { status: string; steps: Array<{ id: string; status: string }> };
  assert.equal(jumpPreflight.status, 'passed', JSON.stringify(jumpPreflight));
  assert.deepEqual(
    jumpPreflight.steps.map((step) => [step.id, step.status]),
    [
      ['dns', 'passed'],
      ['tcp', 'passed'],
      ['jumpHostKey', 'passed'],
      ['jumpAuthentication', 'passed'],
      ['jumpTunnel', 'passed'],
      ['hostKey', 'passed'],
      ['authentication', 'passed'],
    ],
  );

  const uploadSource = join(root, 'upload-世界.txt');
  await writeFile(uploadSource, 'stage4 transfer payload');
  const remotePath = '/home/shellspan/upload-世界.txt';
  const uploaded = (await value('upload_local_paths', {
    request: {
      ...connection,
      localPaths: [uploadSource],
      destinationDirectory: '/home/shellspan',
      conflictPolicies: ['overwrite'],
      operationId: 'stage4-upload',
    },
  })) as { items: Array<{ status: string }> };
  assert.equal(uploaded.items[0].status, 'completed');

  const downloadRoot = join(root, 'download');
  const downloaded = (await value('download_remote_paths', {
    request: {
      ...connection,
      remotePaths: [remotePath],
      destinationDirectory: downloadRoot,
      conflictPolicies: ['overwrite'],
      operationId: 'stage4-download',
    },
  })) as { items: Array<{ status: string }> };
  assert.equal(downloaded.items[0].status, 'completed');
  assert.equal(
    await readFile(join(downloadRoot, 'upload-世界.txt'), 'utf8'),
    'stage4 transfer payload',
  );

  const skipped = (await value('upload_local_paths', {
    request: {
      ...connection,
      localPaths: [uploadSource],
      destinationDirectory: '/home/shellspan',
      conflictPolicies: ['skip'],
      operationId: 'stage4-upload-skip',
    },
  })) as { items: Array<{ status: string }> };
  assert.equal(skipped.items[0].status, 'skipped');
  const preview = (await value('preview_remote_file', {
    request: { ...connection, path: remotePath, operationId: 'stage4-preview' },
  })) as { content: string; isText: boolean; truncated: boolean };
  assert.equal(preview.isText, true);
  assert.equal(preview.truncated, false);
  assert.equal(preview.content, 'stage4 transfer payload');
  console.log('Stage 4 Node basic transfer and preview checks passed.');

  await value('create_remote_entry', {
    request: {
      ...connection,
      parentPath: '/home/shellspan',
      name: 'stage4-ops',
      kind: 'directory',
    },
  });
  await value('create_remote_entry', {
    request: {
      ...connection,
      parentPath: '/home/shellspan/stage4-ops',
      name: 'empty.txt',
      kind: 'file',
    },
  });
  await value('rename_remote_path', {
    request: {
      ...connection,
      path: '/home/shellspan/stage4-ops/empty.txt',
      newName: 'renamed.txt',
    },
  });
  await value('update_remote_permissions', {
    request: {
      ...connection,
      path: '/home/shellspan/stage4-ops/renamed.txt',
      permissions: 0o640,
    },
  });
  console.log('Stage 4 Node create, rename and permission checks passed.');
  await value('copy_remote_path', {
    request: {
      ...connection,
      sourcePath: remotePath,
      destinationDirectory: '/home/shellspan',
      operationId: 'stage4-copy-same-host',
    },
  });
  console.log('Stage 4 Node same-host copy check passed.');
  await value('copy_remote_to_remote', {
    request: {
      sourceConnection: connection,
      destinationConnection: connection,
      sourcePaths: [remotePath],
      destinationDirectory: '/home/shellspan/stage4-ops',
      conflictPolicies: ['fail'],
      operationId: 'stage4-copy-remote',
    },
  });
  console.log('Stage 4 Node remote-to-remote copy check passed.');
  const opsListing = (await value('list_remote_directory', {
    request: {
      ...connection,
      path: '/home/shellspan/stage4-ops',
      requestKey: 'stage4-ops',
      requestId: 1,
    },
  })) as {
    entries: Array<{ name: string; permissions: number; ownerUid: number; groupGid: number }>;
  };
  assert.equal(
    opsListing.entries.find((entry) => entry.name === 'renamed.txt')?.permissions,
    0o640,
  );
  const ownerEntry = opsListing.entries[0];
  const owners = (await value('resolve_remote_entry_owners', {
    request: {
      ...connection,
      ownerIds: [ownerEntry.ownerUid],
      groupIds: [ownerEntry.groupGid],
      requestKey: 'stage4-owners',
      requestId: 1,
    },
  })) as { ownerNames: Record<string, string>; groupNames: Record<string, string> };
  assert.ok(owners.ownerNames[String(ownerEntry.ownerUid)]);
  assert.ok(owners.groupNames[String(ownerEntry.groupGid)]);
  console.log('Stage 4 Node owner resolution check passed.');
  await value('supersede_remote_directory_request', { requestKey: 'superseded', requestId: 2 });
  const superseded = await backend.invoke('list_remote_directory', {
    request: {
      ...connection,
      path: '/home/shellspan',
      requestKey: 'superseded',
      requestId: 1,
    },
  });
  assert.equal(superseded.ok, false);
  await value('disconnect_sftp', { request: connection });
  await value('warm_remote_connection', { request: connection });
  console.log('Stage 4 Node remote filesystem mutation checks passed.');

  const tree = join(root, 'large-directory');
  await mkdir(tree);
  await Promise.all(
    Array.from({ length: 64 }, (_, index) =>
      writeFile(join(tree, `entry-${String(index).padStart(3, '0')}.txt`), `entry ${index}\n`),
    ),
  );
  const treeUpload = (await value('upload_local_paths', {
    request: {
      ...connection,
      localPaths: [tree],
      destinationDirectory: '/home/shellspan',
      conflictPolicies: ['replace'],
      operationId: 'stage4-tree-upload',
    },
  })) as { items: Array<{ status: string }> };
  assert.equal(treeUpload.items[0].status, 'completed');
  const treeDownloadRoot = join(root, 'tree-download');
  const treeDownload = (await value('download_remote_paths', {
    request: {
      ...connection,
      remotePaths: ['/home/shellspan/large-directory'],
      destinationDirectory: treeDownloadRoot,
      conflictPolicies: ['replace'],
      operationId: 'stage4-tree-download',
    },
  })) as { items: Array<{ status: string }> };
  assert.equal(treeDownload.items[0].status, 'completed');
  assert.equal((await readdir(join(treeDownloadRoot, 'large-directory'))).length, 64);
  console.log('Stage 4 Node recursive directory transfer checks passed.');

  const concurrentSources = await Promise.all(
    Array.from({ length: 3 }, async (_, index) => {
      const path = join(root, `concurrent-${index}.bin`);
      await writeFile(path, Buffer.alloc(2 * 1024 * 1024, index + 1));
      return path;
    }),
  );
  const concurrentResults = await Promise.all(
    concurrentSources.map((path, index) =>
      value('upload_local_paths', {
        request: {
          ...connection,
          localPaths: [path],
          destinationDirectory: '/home/shellspan',
          conflictPolicies: ['replace'],
          operationId: `stage4-concurrent-${index}`,
        },
      }),
    ),
  );
  for (const result of concurrentResults)
    assert.equal((result as { items: Array<{ status: string }> }).items[0].status, 'completed');
  console.log('Stage 4 Node concurrent transfer checks passed.');

  const largeSource = join(root, 'cancel-large.bin');
  await writeFile(largeSource, Buffer.alloc(32 * 1024 * 1024, 7));
  const pendingCancellation = backend.invoke('upload_local_paths', {
    request: {
      ...connection,
      localPaths: [largeSource],
      destinationDirectory: '/home/shellspan',
      conflictPolicies: ['replace'],
      operationId: 'stage4-cancel-upload',
    },
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  await value('cancel_upload', { operationId: 'stage4-cancel-upload' });
  const cancelled = await pendingCancellation;
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.match(String(cancelled.error), /cancel|abort/i);
  const afterCancel = (await value('list_remote_directory', {
    request: { ...connection, path: '/home/shellspan', requestKey: 'after-cancel', requestId: 1 },
  })) as { entries: Array<{ name: string }> };
  assert.equal(
    afterCancel.entries.some((entry) => entry.name.includes('.shellspan-')),
    false,
  );
  console.log('Stage 4 Node transfer cancellation checks passed.');

  const health = (await value('collect_remote_health_snapshot', {
    request: {
      operationId: 'stage4-health',
      profileId: 'fixture',
      authorized: true,
      timeoutMs: 5000,
      connection,
    },
  })) as { status: string };
  assert.equal(health.status, 'success');

  const localPort = 22444;
  const forward = (await value('start_port_forward', {
    request: {
      operationId: 'stage4-forward',
      profileId: 'fixture',
      mode: 'manual',
      connection,
      forward: {
        id: 'forward-config',
        name: 'fixture',
        kind: 'local',
        localPort,
        remoteHost: '127.0.0.1',
        remotePort: 18080,
      },
    },
  })) as { status: string };
  assert.equal(forward.status, 'running');
  const banner = await new Promise<string>((resolvePromise, reject) => {
    const socket = connect(localPort, '127.0.0.1');
    socket.setEncoding('utf8');
    socket.once('data', (data) => {
      socket.destroy();
      resolvePromise(String(data));
    });
    socket.once('error', reject);
  });
  assert.match(banner, /shellspan-forward-ok/);
  await value('stop_port_forward', { operationId: 'stage4-forward' });

  const localEcho = createServer((socket) => socket.end('REMOTE_FORWARD_OK\n'));
  await new Promise<void>((resolvePromise, reject) => {
    localEcho.once('error', reject);
    localEcho.listen(0, '127.0.0.1', resolvePromise);
  });
  try {
    const localEchoPort = (localEcho.address() as { port: number }).port;
    const remoteForward = (await value('start_port_forward', {
      request: {
        operationId: 'stage4-remote-forward',
        profileId: 'fixture',
        mode: 'manual',
        connection,
        forward: {
          id: 'remote-forward-config',
          name: 'remote-fixture',
          kind: 'remote',
          localPort: localEchoPort,
          remoteHost: '127.0.0.1',
          remotePort: 18081,
        },
      },
    })) as { status: string };
    assert.equal(remoteForward.status, 'running');
    terminalOutput = '';
    const remoteForwardProbe = (await value('create_session', {
      request: {
        ...connection,
        name: 'Remote forwarding probe',
        terminalCols: 80,
        terminalRows: 24,
      },
    })) as { sessionId: string };
    await value('mark_session_ready', { sessionId: remoteForwardProbe.sessionId });
    await value('write_session', {
      sessionId: remoteForwardProbe.sessionId,
      data: 'nc 127.0.0.1 18081\n',
    });
    const remoteForwardDeadline = Date.now() + 5000;
    while (!terminalOutput.includes('REMOTE_FORWARD_OK') && Date.now() < remoteForwardDeadline)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    assert.match(terminalOutput, /REMOTE_FORWARD_OK/);
    await value('close_session', { sessionId: remoteForwardProbe.sessionId });
    await value('stop_port_forward', { operationId: 'stage4-remote-forward' });
  } finally {
    await new Promise<void>((resolvePromise) => localEcho.close(() => resolvePromise()));
  }
  await value('delete_remote_path', {
    request: {
      ...connection,
      paths: [
        remotePath,
        '/home/shellspan/upload-世界 copy.txt',
        '/home/shellspan/stage4-ops',
        '/home/shellspan/large-directory',
        ...concurrentSources.map((_, index) => `/home/shellspan/concurrent-${index}.bin`),
      ],
      operationId: 'stage4-delete',
    },
  });
  console.log('Stage 4 Node SSH, terminal, SFTP, health and forwarding smoke passed.');
} finally {
  await backend.stop();
  await rm(root, { recursive: true, force: true });
}
