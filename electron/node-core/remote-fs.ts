import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename as localBasename, join as localJoin, posix } from 'node:path';
import { access, mkdir, mkdtemp, readdir, rename as localRename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { openPath } from './local-fs.ts';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { NodeCoreEventSender } from './events.ts';
import type { ConnectionRequest, ConnectedSsh, SshConnector } from './ssh.ts';
import { CancellationRegistry, throwIfCancelled } from './cancellation.ts';

type Pooled = ConnectedSsh & { sftp: SFTPWrapper; users: number };
const posixJoin = (parent: string, child: string) =>
  `${parent.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}` || '/';
const completePreviewExtensions = new Set([
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'apng',
  'tif',
  'tiff',
  'svg',
  'mp3',
  'wav',
  'ogg',
  'oga',
  'flac',
  'm4a',
  'aac',
  'opus',
  'aif',
  'aiff',
  'caf',
  'mp4',
  'webm',
  'ogv',
  'mov',
  'm4v',
  'mpg',
  'mpeg',
  'mkv',
  'pdf',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'zip',
  'doc',
  'docx',
  'xlsx',
  'pptx',
]);

function callback<T>(
  operation: (done: (error: Error | null | undefined, value: T) => void) => void,
) {
  return new Promise<T>((resolve, reject) =>
    operation((error, value) => (error ? reject(error) : resolve(value))),
  );
}

function kind(mode: number) {
  const type = mode & 0o170000;
  return type === 0o040000
    ? 'directory'
    : type === 0o120000
      ? 'symlink'
      : type === 0o100000
        ? 'file'
        : 'other';
}

function remoteName(value: string) {
  const name = value.trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || /[\0\r\n]/.test(name))
    throw new Error('remote entry name is invalid');
  return name;
}

export class RemoteFsManager {
  private readonly pool = new Map<string, Promise<Pooled>>();
  private readonly operations = {
    upload: new CancellationRegistry(),
    download: new CancellationRegistry(),
    delete: new CancellationRegistry(),
    copy: new CancellationRegistry(),
    read: new CancellationRegistry(),
  };
  private readonly superseded = new Map<string, number>();

  constructor(
    private readonly ssh: SshConnector,
    private readonly events: NodeCoreEventSender,
  ) {}

  private key(request: ConnectionRequest) {
    return createHash('sha256')
      .update(
        JSON.stringify({
          host: request.host,
          port: request.port,
          username: request.username,
          authMethod: request.authMethod,
          keychainKeyId: request.keychainKeyId,
          profileId: request.profileId,
          jumpHost: request.jumpHost,
          password: request.password,
          privateKeyData: request.privateKeyData,
        }),
      )
      .digest('hex');
  }

  private async connection(request: ConnectionRequest, signal?: AbortSignal) {
    const key = this.key(request);
    let pending = this.pool.get(key);
    if (!pending) {
      pending = (async () => {
        const connection = await this.ssh.connect(request, signal);
        const sftp = await callback<SFTPWrapper>((done) => connection.client.sftp(done));
        const pooled = { ...connection, sftp, users: 0 };
        connection.client.once('close', () => this.pool.delete(key));
        return pooled;
      })();
      this.pool.set(key, pending);
      pending.catch(() => this.pool.delete(key));
    }
    return pending;
  }

  async warm(request: ConnectionRequest, signal?: AbortSignal) {
    await this.connection(request, signal);
    return null;
  }

  async disconnect(request: ConnectionRequest) {
    const key = this.key(request);
    const pending = this.pool.get(key);
    this.pool.delete(key);
    if (pending) this.ssh.close(await pending);
    return null;
  }

  async list(
    request: ConnectionRequest & { path?: string; requestKey: string; requestId: number },
  ) {
    if ((this.superseded.get(request.requestKey) ?? -1) > request.requestId)
      throw new Error('remote directory request superseded');
    const { sftp } = await this.connection(request);
    const path = request.path || '.';
    const entries = await callback<Array<{ filename: string; attrs: Stats }>>((done) =>
      sftp.readdir(path, done),
    );
    if ((this.superseded.get(request.requestKey) ?? -1) > request.requestId)
      throw new Error('remote directory request superseded');
    const values = entries
      .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .map((entry) => ({
        path: posixJoin(path, entry.filename),
        name: entry.filename,
        kind: kind(entry.attrs.mode),
        size: entry.attrs.size,
        modifiedAt: entry.attrs.mtime,
        permissions: entry.attrs.mode & 0o7777,
        ownerUid: entry.attrs.uid,
        groupGid: entry.attrs.gid,
      }));
    values.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name)
        : a.kind === 'directory'
          ? -1
          : b.kind === 'directory'
            ? 1
            : a.name.localeCompare(b.name),
    );
    const clean = path.replace(/\/+$/, '') || '/';
    const slash = clean.lastIndexOf('/');
    return {
      path: clean,
      parentPath: clean === '/' ? null : slash <= 0 ? '/' : clean.slice(0, slash),
      entries: values,
    };
  }

  supersede(key: string, id: number) {
    this.superseded.set(key, Math.max(id, this.superseded.get(key) ?? -1));
    return null;
  }

  async create(request: ConnectionRequest & { parentPath: string; name: string; kind: string }) {
    const { sftp } = await this.connection(request);
    const path = posixJoin(request.parentPath, remoteName(request.name));
    if (request.kind === 'directory') await callback<void>((done) => sftp.mkdir(path, done));
    else {
      if (request.kind !== 'file') throw new Error('remote entry kind is invalid');
      const handle = await callback<Buffer>((done) => sftp.open(path, 'wx', done));
      await callback<void>((done) => sftp.close(handle, done));
    }
    return null;
  }

  async rename(request: ConnectionRequest & { path: string; newName: string }) {
    const { sftp } = await this.connection(request);
    const parent = request.path.slice(0, request.path.lastIndexOf('/')) || '/';
    await callback<void>((done) =>
      sftp.rename(request.path, posixJoin(parent, remoteName(request.newName)), done),
    );
    return null;
  }

  async chmod(request: ConnectionRequest & { path: string; permissions: number }) {
    const { sftp } = await this.connection(request);
    await callback<void>((done) => sftp.chmod(request.path, request.permissions, done));
    return null;
  }

  private async removeTree(sftp: SFTPWrapper, path: string, signal: AbortSignal) {
    throwIfCancelled(signal);
    const attrs = await callback<Stats>((done) => sftp.lstat(path, done));
    if (kind(attrs.mode) === 'directory') {
      const children = await callback<Array<{ filename: string }>>((done) =>
        sftp.readdir(path, done),
      );
      for (const child of children)
        if (child.filename !== '.' && child.filename !== '..')
          await this.removeTree(sftp, posixJoin(path, child.filename), signal);
      await callback<void>((done) => sftp.rmdir(path, done));
    } else await callback<void>((done) => sftp.unlink(path, done));
  }

  async delete(request: ConnectionRequest & { paths: string[]; operationId: string }) {
    const controller = this.operations.delete.begin(request.operationId);
    try {
      const { sftp } = await this.connection(request, controller.signal);
      let completed = 0;
      for (const path of request.paths) {
        await this.removeTree(sftp, path, controller.signal);
        completed++;
        await this.events.emit('delete-progress', {
          operationId: request.operationId,
          totalSteps: request.paths.length,
          completedSteps: completed,
          currentPath: path,
        });
      }
      return null;
    } finally {
      this.operations.delete.finish(request.operationId, controller);
    }
  }

  cancel(operationId: string, kind: keyof RemoteFsManager['operations']) {
    this.operations[kind].cancel(operationId);
    return null;
  }

  private async remoteExists(sftp: SFTPWrapper, path: string) {
    return callback<Stats>((done) => sftp.stat(path, done)).then(
      (value) => value,
      () => undefined,
    );
  }

  private async localExists(path: string) {
    return access(path).then(
      () => true,
      () => false,
    );
  }

  private async uploadFile(
    sftp: SFTPWrapper,
    source: string,
    destination: string,
    signal: AbortSignal,
  ) {
    const temporary = `${destination}.shellspan-${randomUUID()}.part`;
    try {
      await pipeline(createReadStream(source), sftp.createWriteStream(temporary, { flags: 'wx' }), {
        signal,
      });
      await callback<void>((done) => sftp.ext_openssh_rename(temporary, destination, done)).catch(
        async () => {
          if (await this.remoteExists(sftp, destination))
            await callback<void>((done) => sftp.unlink(destination, done));
          await callback<void>((done) => sftp.rename(temporary, destination, done));
        },
      );
    } catch (error) {
      await callback<void>((done) => sftp.unlink(temporary, done)).catch(() => {});
      throw error;
    }
  }

  private async downloadFile(
    sftp: SFTPWrapper,
    source: string,
    destination: string,
    signal: AbortSignal,
  ) {
    const temporary = `${destination}.shellspan-${randomUUID()}.part`;
    try {
      await pipeline(sftp.createReadStream(source), createWriteStream(temporary, { flags: 'wx' }), {
        signal,
      });
      if (process.platform === 'win32') await rm(destination, { force: true });
      await localRename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async ensureRemoteDirectory(sftp: SFTPWrapper, path: string) {
    if (!path || path === '/') return;
    if (await this.remoteExists(sftp, path)) return;
    await this.ensureRemoteDirectory(sftp, path.slice(0, path.lastIndexOf('/')) || '/');
    await callback<void>((done) => sftp.mkdir(path, done));
  }

  private async uniqueRemoteDestination(sftp: SFTPWrapper, directory: string, baseName: string) {
    const direct = posixJoin(directory, baseName);
    if (!(await this.remoteExists(sftp, direct))) return direct;
    const dot = baseName.lastIndexOf('.');
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    const extension = dot > 0 ? baseName.slice(dot) : '';
    for (let index = 1; index < 1000; index++) {
      const candidate = posixJoin(
        directory,
        `${stem} copy${index === 1 ? '' : ` ${index}`}${extension}`,
      );
      if (!(await this.remoteExists(sftp, candidate))) return candidate;
    }
    throw new Error(`failed to find an available destination name for ${baseName}`);
  }

  private targetName(name: string, exists: boolean, policy?: string) {
    if (!exists) return name;
    if (policy === 'skip') return undefined;
    if (policy === 'fail' || !policy) throw new Error(`remote path already exists: ${name}`);
    return name;
  }

  async upload(
    request: ConnectionRequest & {
      localPaths: string[];
      destinationDirectory: string;
      conflictPolicies: string[];
      operationId: string;
    },
  ) {
    if (!request.localPaths.length) throw new Error('no local files were provided for upload');
    if (
      request.conflictPolicies.length > 0 &&
      request.conflictPolicies.length !== request.localPaths.length
    )
      throw new Error('upload conflict policy count does not match local paths');
    const controller = this.operations.upload.begin(request.operationId);
    const items = [];
    try {
      const { sftp } = await this.connection(request, controller.signal);
      for (let index = 0; index < request.localPaths.length; index++) {
        const source = request.localPaths[index];
        const destination = posixJoin(request.destinationDirectory, localBasename(source));
        try {
          throwIfCancelled(controller.signal);
          const name = this.targetName(
            localBasename(source),
            Boolean(await this.remoteExists(sftp, destination)),
            request.conflictPolicies[index],
          );
          if (!name) {
            items.push({ sourcePath: source, status: 'skipped' });
            continue;
          }
          const metadata = await stat(source);
          const existing = await this.remoteExists(sftp, destination);
          const policy = request.conflictPolicies[index] || 'fail';
          if (existing && policy === 'replace')
            await this.removeTree(sftp, destination, controller.signal);
          if (
            existing &&
            policy === 'overwrite' &&
            metadata.isDirectory() !== (kind(existing.mode) === 'directory')
          )
            throw new Error('overwrite requires matching file kinds; use replace instead');
          if (metadata.isDirectory())
            await this.uploadDirectory(sftp, source, destination, controller.signal);
          else await this.uploadFile(sftp, source, destination, controller.signal);
          items.push({ sourcePath: source, destinationPath: destination, status: 'completed' });
        } catch (error) {
          if (controller.signal.aborted) throw new Error('upload cancelled');
          items.push({
            sourcePath: source,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!controller.signal.aborted)
          await this.events.emit('upload-progress', {
            operationId: request.operationId,
            totalBytes: 0,
            uploadedBytes: 0,
            totalSteps: request.localPaths.length,
            completedSteps: index + 1,
            currentPath: source,
          });
      }
      return { items };
    } finally {
      this.operations.upload.finish(request.operationId, controller);
    }
  }

  private async uploadDirectory(
    sftp: SFTPWrapper,
    source: string,
    destination: string,
    signal: AbortSignal,
  ) {
    await this.ensureRemoteDirectory(sftp, destination);
    for (const name of await readdir(source)) {
      throwIfCancelled(signal);
      const local = localJoin(source, name);
      const remote = posixJoin(destination, name);
      if ((await stat(local)).isDirectory())
        await this.uploadDirectory(sftp, local, remote, signal);
      else await this.uploadFile(sftp, local, remote, signal);
    }
  }

  async download(
    request: ConnectionRequest & {
      remotePaths: string[];
      destinationDirectory: string;
      conflictPolicies: string[];
      operationId: string;
    },
  ) {
    if (!request.remotePaths.length) throw new Error('no remote paths were provided for download');
    if (
      request.conflictPolicies.length > 0 &&
      request.conflictPolicies.length !== request.remotePaths.length
    )
      throw new Error('download conflict policy count does not match remote paths');
    const controller = this.operations.download.begin(request.operationId);
    const items = [];
    try {
      const { sftp } = await this.connection(request, controller.signal);
      await mkdir(request.destinationDirectory, { recursive: true });
      for (let index = 0; index < request.remotePaths.length; index++) {
        const source = request.remotePaths[index];
        const destination = localJoin(request.destinationDirectory, posix.basename(source));
        try {
          throwIfCancelled(controller.signal);
          const attrs = await callback<Stats>((done) => sftp.stat(source, done));
          const exists = await this.localExists(destination);
          const policy = request.conflictPolicies[index] || 'fail';
          if (exists && policy === 'skip') {
            items.push({ sourcePath: source, status: 'skipped' });
            continue;
          }
          if (exists && policy === 'fail')
            throw new Error(`local path already exists: ${destination}`);
          if (exists) {
            const local = await stat(destination);
            if (
              policy === 'overwrite' &&
              local.isDirectory() !== (kind(attrs.mode) === 'directory')
            )
              throw new Error('overwrite requires matching file kinds; use replace instead');
            if (policy === 'replace') await rm(destination, { recursive: true, force: true });
          }
          if (kind(attrs.mode) === 'directory')
            await this.downloadDirectory(sftp, source, destination, controller.signal);
          else await this.downloadFile(sftp, source, destination, controller.signal);
          items.push({
            sourcePath: source,
            destinationPath: destination.replaceAll('\\', '/'),
            status: 'completed',
          });
        } catch (error) {
          if (controller.signal.aborted) throw new Error('download cancelled');
          items.push({
            sourcePath: source,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!controller.signal.aborted)
          await this.events.emit('download-progress', {
            operationId: request.operationId,
            totalBytes: 0,
            downloadedBytes: 0,
            totalSteps: request.remotePaths.length,
            completedSteps: index + 1,
            currentPath: source,
          });
      }
      return { items };
    } finally {
      this.operations.download.finish(request.operationId, controller);
    }
  }

  private async downloadDirectory(
    sftp: SFTPWrapper,
    source: string,
    destination: string,
    signal: AbortSignal,
  ) {
    await mkdir(destination, { recursive: true });
    const children = await callback<Array<{ filename: string; attrs: Stats }>>((done) =>
      sftp.readdir(source, done),
    );
    for (const child of children) {
      if (child.filename === '.' || child.filename === '..') continue;
      throwIfCancelled(signal);
      const remote = posixJoin(source, child.filename);
      const local = localJoin(destination, child.filename);
      if (kind(child.attrs.mode) === 'directory')
        await this.downloadDirectory(sftp, remote, local, signal);
      else await this.downloadFile(sftp, remote, local, signal);
    }
  }

  async preview(request: ConnectionRequest & { path: string; operationId: string }) {
    const controller = this.operations.read.begin(request.operationId);
    try {
      const { sftp } = await this.connection(request, controller.signal);
      const attrs = await callback<Stats>((done) => sftp.stat(request.path, done));
      if (kind(attrs.mode) === 'directory') throw new Error('cannot preview a directory');
      const name = posix.basename(request.path);
      const extension = name.includes('.')
        ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        : '';
      const requiresComplete = completePreviewExtensions.has(extension);
      const limit = requiresComplete ? 16 * 1024 * 1024 : 256 * 1024;
      if (requiresComplete && attrs.size > limit)
        return {
          path: request.path,
          name,
          content: '',
          size: attrs.size,
          isText: false,
          contentEncoding: 'none',
          truncated: true,
        };
      const stream = sftp.createReadStream(request.path, { start: 0, end: limit });
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const abort = () => stream.destroy(new Error('remote file read cancelled'));
        controller.signal.addEventListener('abort', abort, { once: true });
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.once('error', (error: Error) => {
          controller.signal.removeEventListener('abort', abort);
          reject(error);
        });
        stream.once('end', () => {
          controller.signal.removeEventListener('abort', abort);
          resolve();
        });
      });
      const bytes = Buffer.concat(chunks).subarray(0, limit);
      const truncated = attrs.size > limit;
      let text: string | undefined;
      try {
        text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
      } catch {}
      return {
        path: request.path,
        name,
        content: text === undefined ? bytes.toString('base64') : text,
        size: attrs.size,
        isText: text !== undefined,
        contentEncoding: text === undefined ? 'base64' : 'utf8',
        truncated,
      };
    } finally {
      this.operations.read.finish(request.operationId, controller);
    }
  }

  private async copyEntry(
    sourceSftp: SFTPWrapper,
    destinationSftp: SFTPWrapper,
    source: string,
    destination: string,
    signal: AbortSignal,
  ) {
    throwIfCancelled(signal);
    const attrs = await callback<Stats>((done) => sourceSftp.lstat(source, done));
    if (kind(attrs.mode) === 'directory') {
      await this.ensureRemoteDirectory(destinationSftp, destination);
      const children = await callback<Array<{ filename: string }>>((done) =>
        sourceSftp.readdir(source, done),
      );
      for (const child of children)
        if (child.filename !== '.' && child.filename !== '..')
          await this.copyEntry(
            sourceSftp,
            destinationSftp,
            posixJoin(source, child.filename),
            posixJoin(destination, child.filename),
            signal,
          );
    } else {
      const reader = sourceSftp.createReadStream(source);
      const temporary = `${destination}.shellspan-${randomUUID()}.copy`;
      try {
        await pipeline(reader, destinationSftp.createWriteStream(temporary, { flags: 'wx' }), {
          signal,
        });
        await callback<void>((done) =>
          destinationSftp.ext_openssh_rename(temporary, destination, done),
        ).catch(async () => {
          if (await this.remoteExists(destinationSftp, destination))
            await callback<void>((done) => destinationSftp.unlink(destination, done));
          await callback<void>((done) => destinationSftp.rename(temporary, destination, done));
        });
      } catch (error) {
        await callback<void>((done) => destinationSftp.unlink(temporary, done)).catch(() => {});
        throw error;
      }
    }
  }

  async copyRemote(
    request: ConnectionRequest & {
      sourcePath: string;
      destinationDirectory: string;
      operationId: string;
    },
  ) {
    const controller = this.operations.copy.begin(request.operationId);
    try {
      const { sftp } = await this.connection(request, controller.signal);
      const destination = await this.uniqueRemoteDestination(
        sftp,
        request.destinationDirectory,
        posix.basename(request.sourcePath),
      );
      if (
        destination === request.sourcePath ||
        destination.startsWith(`${request.sourcePath.replace(/\/+$/, '')}/`)
      )
        throw new Error('cannot paste a directory into itself');
      await this.copyEntry(sftp, sftp, request.sourcePath, destination, controller.signal);
      return null;
    } finally {
      this.operations.copy.finish(request.operationId, controller);
    }
  }

  async copyRemoteToRemote(request: {
    sourceConnection: ConnectionRequest;
    destinationConnection: ConnectionRequest;
    sourcePaths: string[];
    destinationDirectory: string;
    conflictPolicies: string[];
    operationId: string;
  }) {
    if (!request.sourcePaths.length) throw new Error('no remote paths were provided');
    if (
      request.conflictPolicies.length > 0 &&
      request.conflictPolicies.length !== request.sourcePaths.length
    )
      throw new Error('conflict policy count does not match remote paths');
    const controller = this.operations.copy.begin(request.operationId);
    try {
      const [source, destination] = await Promise.all([
        this.connection(request.sourceConnection, controller.signal),
        this.connection(request.destinationConnection, controller.signal),
      ]);
      let completed = 0;
      for (let index = 0; index < request.sourcePaths.length; index++) {
        const path = request.sourcePaths[index];
        throwIfCancelled(controller.signal);
        const target = posixJoin(request.destinationDirectory, posix.basename(path));
        const existing = await this.remoteExists(destination.sftp, target);
        const policy = request.conflictPolicies[index] || 'fail';
        if (existing && policy === 'skip') {
          completed++;
          continue;
        }
        if (existing && policy === 'fail') throw new Error(`remote path already exists: ${target}`);
        if (existing && policy === 'replace')
          await this.removeTree(destination.sftp, target, controller.signal);
        if (existing && policy === 'overwrite') {
          const sourceAttrs = await callback<Stats>((done) => source.sftp.lstat(path, done));
          if ((kind(sourceAttrs.mode) === 'directory') !== (kind(existing.mode) === 'directory'))
            throw new Error('overwrite requires matching file kinds; use replace instead');
        }
        await this.copyEntry(source.sftp, destination.sftp, path, target, controller.signal);
        await this.events.emit('remote-copy-progress', {
          operationId: request.operationId,
          totalBytes: 0,
          copiedBytes: 0,
          totalSteps: request.sourcePaths.length,
          completedSteps: ++completed,
          currentPath: path,
        });
      }
      return null;
    } finally {
      this.operations.copy.finish(request.operationId, controller);
    }
  }

  async open(request: ConnectionRequest & { path: string; operationId: string }) {
    const controller = this.operations.read.begin(request.operationId);
    try {
      const { sftp } = await this.connection(request, controller.signal);
      const root = await mkdtemp(localJoin(tmpdir(), 'shellspan-open-'));
      const destination = localJoin(root, posix.basename(request.path) || 'remote-file');
      await this.downloadFile(sftp, request.path, destination, controller.signal);
      throwIfCancelled(controller.signal);
      return openPath(destination);
    } finally {
      this.operations.read.finish(request.operationId, controller);
    }
  }

  async owners(request: ConnectionRequest & { ownerIds: number[]; groupIds: number[] }) {
    const connection = await this.connection(request);
    const ownerNames: Record<string, string> = {};
    const groupNames: Record<string, string> = {};
    const quote = (value: number) => String(Math.max(0, Math.trunc(value)));
    const command = `getent passwd ${request.ownerIds.map(quote).join(' ')}; getent group ${request.groupIds.map(quote).join(' ')}`;
    const output = await new Promise<string>((resolve, reject) =>
      connection.client.exec(command, (error, stream) => {
        if (error) return reject(error);
        let value = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => (value += chunk));
        stream.on('close', () => resolve(value));
      }),
    );
    for (const line of output.split('\n')) {
      const fields = line.split(':');
      const id = fields[2];
      if (!id) continue;
      if (request.ownerIds.includes(Number(id))) ownerNames[id] = fields[0];
      if (request.groupIds.includes(Number(id))) groupNames[id] = fields[0];
    }
    return { ownerNames, groupNames };
  }

  async stop() {
    for (const registry of Object.values(this.operations)) registry.cancelAll();
    for (const pending of this.pool.values())
      await pending.then(
        (connection) => this.ssh.close(connection),
        () => {},
      );
    this.pool.clear();
  }
}
