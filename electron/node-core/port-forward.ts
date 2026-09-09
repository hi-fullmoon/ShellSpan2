import { createServer, connect as connectTcp } from 'node:net';
import type { Server, Socket } from 'node:net';
import type { ConnectedSsh, ConnectionRequest, SshConnector } from './ssh.ts';
import type { NodeCoreEventSender } from './events.ts';

type Runtime = {
  operationId: string;
  profileId: string;
  configId: string;
  name: string;
  kind: 'local' | 'remote';
  mode: 'manual' | 'auto';
  status: string;
  bytesSent: number;
  bytesReceived: number;
  startedAt?: number;
  stoppedAt?: number;
};
type Managed = {
  runtime: Runtime;
  connection: ConnectedSsh;
  server?: Server;
  remotePort?: number;
  remoteHost?: string;
  sockets: Set<Socket>;
};

export class PortForwardManager {
  private readonly forwards = new Map<string, Managed>();
  constructor(
    private readonly ssh: SshConnector,
    private readonly events: NodeCoreEventSender,
  ) {}

  list() {
    return [...this.forwards.values()].map((item) => ({ ...item.runtime }));
  }

  async start(request: {
    operationId: string;
    profileId: string;
    mode: 'manual' | 'auto';
    connection: ConnectionRequest;
    forward: {
      id: string;
      name: string;
      kind: 'local' | 'remote';
      localPort: number;
      remoteHost: string;
      remotePort: number;
    };
  }) {
    if (this.forwards.has(request.operationId))
      throw new Error('port forward operation already exists');
    if (
      [...this.forwards.values()].some(
        (item) =>
          ['starting', 'running', 'stopping'].includes(item.runtime.status) &&
          item.runtime.profileId === request.profileId &&
          item.runtime.configId === request.forward.id,
      )
    )
      throw new Error('port forward is already active for this connection');
    for (const [label, value] of [
      ['local', request.forward.localPort],
      ['remote', request.forward.remotePort],
    ] as const)
      if (!Number.isInteger(value) || value < 1 || value > 65535)
        throw new Error(`${label} port is invalid`);
    if (!request.forward.remoteHost.trim() || /[\0\r\n]/.test(request.forward.remoteHost))
      throw new Error('remote host is invalid');
    const runtime: Runtime = {
      operationId: request.operationId,
      profileId: request.profileId,
      configId: request.forward.id,
      name: request.forward.name,
      kind: request.forward.kind,
      mode: request.mode,
      status: 'starting',
      bytesSent: 0,
      bytesReceived: 0,
    };
    const connection = await this.ssh.connect(request.connection);
    const managed: Managed = { runtime, connection, sockets: new Set() };
    this.forwards.set(request.operationId, managed);
    try {
      if (request.forward.kind === 'local') {
        const server = createServer((socket) => {
          managed.sockets.add(socket);
          socket.once('close', () => managed.sockets.delete(socket));
          connection.client.forwardOut(
            socket.remoteAddress || '127.0.0.1',
            socket.remotePort || 0,
            request.forward.remoteHost,
            request.forward.remotePort,
            (error, channel) => {
              if (error) return socket.destroy(error);
              managed.sockets.add(channel as unknown as Socket);
              channel.once('close', () => managed.sockets.delete(channel as unknown as Socket));
              socket.on('data', (data) => (runtime.bytesSent += data.length));
              channel.on('data', (data: Buffer) => (runtime.bytesReceived += data.length));
              socket.pipe(channel).pipe(socket);
            },
          );
        });
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(request.forward.localPort, '127.0.0.1', resolve);
        });
        managed.server = server;
      } else {
        await new Promise<void>((resolve, reject) =>
          connection.client.forwardIn(
            request.forward.remoteHost,
            request.forward.remotePort,
            (error, port) => {
              if (error) reject(error);
              else {
                managed.remotePort = port;
                managed.remoteHost = request.forward.remoteHost;
                resolve();
              }
            },
          ),
        );
        connection.client.on('tcp connection', (_info, accept) => {
          const channel = accept();
          const socket = connectTcp(request.forward.localPort, '127.0.0.1');
          managed.sockets.add(socket);
          managed.sockets.add(channel as unknown as Socket);
          socket.once('close', () => managed.sockets.delete(socket));
          channel.once('close', () => managed.sockets.delete(channel as unknown as Socket));
          socket.on('data', (data) => (runtime.bytesSent += data.length));
          channel.on('data', (data: Buffer) => (runtime.bytesReceived += data.length));
          channel.pipe(socket).pipe(channel);
        });
      }
      runtime.status = 'running';
      runtime.startedAt = Date.now();
      await this.events.emit('port-forward-event', runtime);
      return { ...runtime };
    } catch (error) {
      this.forwards.delete(request.operationId);
      this.ssh.close(connection);
      throw error;
    }
  }

  async stopOne(id: string) {
    const managed = this.forwards.get(id);
    if (!managed) throw new Error(`port forward ${id} not found`);
    if (managed.runtime.status === 'stopped' || managed.runtime.status === 'failed')
      return { ...managed.runtime };
    managed.runtime.status = 'stopping';
    await this.events.emit('port-forward-event', managed.runtime);
    for (const socket of managed.sockets) socket.destroy();
    managed.sockets.clear();
    managed.runtime.status = 'stopped';
    managed.runtime.stoppedAt = Date.now();
    if (managed.server)
      await new Promise<void>((resolve) => managed.server!.close(() => resolve()));
    if (managed.remotePort)
      await new Promise<void>((resolve) =>
        managed.connection.client.unforwardIn(managed.remoteHost!, managed.remotePort!, () =>
          resolve(),
        ),
      );
    this.ssh.close(managed.connection);
    await this.events.emit('port-forward-event', managed.runtime);
    return { ...managed.runtime };
  }

  async stopAll() {
    const values = [];
    for (const [id, value] of this.forwards)
      if (value.runtime.status === 'running' || value.runtime.status === 'starting')
        values.push(await this.stopOne(id));
    return values;
  }
}
