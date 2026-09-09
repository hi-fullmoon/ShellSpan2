import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { Socket } from 'node:net';
import type { CredentialManager } from './credentials.ts';
import type { HostTrustManager } from './host-trust.ts';

export type ConnectionRequest = {
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  password?: string;
  privateKeyData?: string;
  passphrase?: string;
  keychainKeyId?: string;
  profileId?: string;
  jumpHost?: ConnectionRequest;
};

export type ConnectedSsh = { client: Client; jump?: Client };

export class SshConnector {
  constructor(
    private readonly trust: HostTrustManager,
    private readonly credentials?: CredentialManager,
  ) {}

  private async config(request: ConnectionRequest, sock?: Socket): Promise<ConnectConfig> {
    if (!request.host.trim() || /[\0\r\n]/.test(request.host)) throw new Error('host is invalid');
    if (!request.username.trim() || /[\0\r\n]/.test(request.username))
      throw new Error('username is invalid');
    if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535)
      throw new Error('port is invalid');
    let password = request.password;
    let privateKey = request.privateKeyData;
    let passphrase = request.passphrase;
    if (!password && request.profileId)
      password = await this.credentials?.profilePassword(request.profileId);
    if (!privateKey && request.keychainKeyId)
      privateKey = (await this.credentials?.privateKey(request.keychainKeyId)) ?? undefined;
    if (!passphrase && request.profileId)
      passphrase = await this.credentials?.profileSecret(request.profileId, 'passphrase');
    return {
      host: request.host.trim(),
      port: request.port,
      username: request.username,
      sock,
      readyTimeout: 10_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      tryKeyboard: request.authMethod === 'password',
      ...(request.authMethod === 'password' ? { password } : { privateKey, passphrase }),
      hostVerifier: (key: Buffer, callback: (accept: boolean) => void) => {
        void this.trust.verify(request.host, request.port, key).then(
          () => callback(true),
          () => callback(false),
        );
      },
    };
  }

  private async connectClient(config: ConnectConfig, signal?: AbortSignal) {
    return new Promise<Client>((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (error) {
          client.destroy();
          reject(error);
        } else resolve(client);
      };
      const abort = () => finish(new Error('connection cancelled'));
      if (signal?.aborted) {
        finish(new Error('connection cancelled'));
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      client.on('ready', () => finish());
      client.on('error', (error) => finish(error));
      client.on('keyboard-interactive', (_name, _instructions, _language, prompts, done) => {
        done(prompts.map(() => String(config.password ?? '')));
      });
      client.connect(config);
    });
  }

  async connect(request: ConnectionRequest, signal?: AbortSignal): Promise<ConnectedSsh> {
    if (!request.jumpHost)
      return { client: await this.connectClient(await this.config(request), signal) };
    const { jump, socket } = await this.openJumpTunnel(request, signal);
    try {
      const client = await this.connectClient(await this.config(request, socket), signal);
      return { client, jump };
    } catch (error) {
      jump.end();
      throw error;
    }
  }

  async connectDirect(request: ConnectionRequest, signal?: AbortSignal) {
    return this.connectClient(await this.config({ ...request, jumpHost: undefined }), signal);
  }

  async openJumpTunnel(request: ConnectionRequest, signal?: AbortSignal) {
    if (!request.jumpHost) throw new Error('jump host is required');
    const jump = await this.connectDirect(request.jumpHost, signal);
    try {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const aborted = () => reject(new Error('connection cancelled'));
        signal?.addEventListener('abort', aborted, { once: true });
        jump.forwardOut('127.0.0.1', 0, request.host, request.port, (error, stream) => {
          signal?.removeEventListener('abort', aborted);
          if (error) reject(error);
          else resolve(stream as unknown as Socket);
        });
      });
      return { jump, socket };
    } catch (error) {
      jump.end();
      throw error;
    }
  }

  close(connection: ConnectedSsh) {
    connection.client.end();
    connection.jump?.end();
  }
}
