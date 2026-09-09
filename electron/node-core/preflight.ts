import { lookup } from 'node:dns/promises';
import { connect as connectTcp } from 'node:net';
import { CancellationRegistry } from './cancellation.ts';
import type { ConnectionRequest, SshConnector } from './ssh.ts';
import type { HostTrustManager } from './host-trust.ts';

export class PreflightManager {
  private readonly operations = new CancellationRegistry();
  constructor(
    private readonly trust: HostTrustManager,
    private readonly ssh: SshConnector,
  ) {}

  cancel(id: string) {
    this.operations.cancel(id);
    return null;
  }

  async run(request: ConnectionRequest & { operationId: string }) {
    const controller = this.operations.begin(request.operationId);
    const steps: Array<Record<string, unknown>> = [];
    const expected = [
      'dns',
      'tcp',
      ...(request.jumpHost ? ['jumpHostKey', 'jumpAuthentication', 'jumpTunnel'] : []),
      'hostKey',
      'authentication',
    ];
    const add = (id: string, status: string, detail: string, extra: object = {}) =>
      steps.push({ id, status, detail, trustable: false, ...extra });
    const finish = (status: string, blockedReason = 'not run because an earlier step failed') => {
      const completed = new Set(steps.map((step) => step.id));
      for (const id of expected) if (!completed.has(id)) add(id, 'blocked', blockedReason);
      return { operationId: request.operationId, status, checkedAt: Date.now(), steps };
    };
    const verifyKey = async (
      id: 'jumpHostKey' | 'hostKey',
      host: string,
      port: number,
      socket?: import('node:net').Socket,
    ) => {
      const key = await this.trust.check(host, port, controller.signal, socket);
      if (key.status === 'match') {
        add(id, 'passed', 'the presented host key matches the trusted key', {
          host,
          port,
          fingerprint: key.fingerprint,
        });
        return undefined;
      }
      steps.push({
        id,
        status: key.status === 'notFound' ? 'warning' : 'failed',
        detail: key.message || key.status,
        trustable: key.status === 'notFound',
        host,
        port,
        fingerprint: key.fingerprint,
      });
      return key.status === 'notFound' ? 'attention' : 'failed';
    };
    try {
      const network = request.jumpHost || request;
      const address = await lookup(network.host);
      if (controller.signal.aborted) throw new Error('connection cancelled');
      add(
        'dns',
        'passed',
        request.jumpHost
          ? `resolved jump host ${network.host} to ${address.address}; target DNS is delegated through the tunnel`
          : `resolved ${network.host} to ${address.address}`,
        { host: network.host, port: network.port },
      );
      await new Promise<void>((resolve, reject) => {
        const socket = connectTcp(network.port, network.host);
        const abort = () => socket.destroy(new Error('connection cancelled'));
        controller.signal.addEventListener('abort', abort, { once: true });
        socket.setTimeout(5000, () => socket.destroy(new Error('connection timed out')));
        socket.once('connect', () => {
          controller.signal.removeEventListener('abort', abort);
          socket.destroy();
          resolve();
        });
        socket.once('error', (error) => {
          controller.signal.removeEventListener('abort', abort);
          reject(error);
        });
      });
      add('tcp', 'passed', `connected to ${network.host}:${network.port}`, {
        host: network.host,
        port: network.port,
      });

      if (request.jumpHost) {
        const jumpKeyStatus = await verifyKey(
          'jumpHostKey',
          request.jumpHost.host,
          request.jumpHost.port,
        );
        if (jumpKeyStatus)
          return finish(jumpKeyStatus, 'not run because the jump-host key is not trusted');
        const tunnel = await this.ssh.openJumpTunnel(request, controller.signal);
        add('jumpAuthentication', 'passed', 'jump-host authentication succeeded', {
          host: request.jumpHost.host,
          port: request.jumpHost.port,
        });
        add('jumpTunnel', 'passed', 'the jump host opened a tunnel to the target', {
          host: request.host,
          port: request.port,
        });
        let targetStatus;
        try {
          targetStatus = await verifyKey('hostKey', request.host, request.port, tunnel.socket);
        } finally {
          tunnel.jump.end();
        }
        if (targetStatus)
          return finish(targetStatus, 'authentication was blocked by target host-key verification');
      } else {
        const targetStatus = await verifyKey('hostKey', request.host, request.port);
        if (targetStatus)
          return finish(targetStatus, 'authentication was blocked by host-key verification');
      }

      const connection = await this.ssh.connect(request, controller.signal);
      this.ssh.close(connection);
      add('authentication', 'passed', 'SSH authentication succeeded; no remote command was run', {
        host: request.host,
        port: request.port,
      });
      return finish('passed');
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const completed = new Set(steps.map((step) => step.id));
      const failedStep = expected.find((id) => !completed.has(id));
      if (failedStep)
        add(
          failedStep,
          cancelled ? 'blocked' : 'failed',
          cancelled ? 'cancelled' : error instanceof Error ? error.message : String(error),
        );
      return finish(
        cancelled ? 'cancelled' : 'failed',
        cancelled
          ? 'not run because the preflight was cancelled'
          : 'not run because an earlier step failed',
      );
    } finally {
      this.operations.finish(request.operationId, controller);
    }
  }

  stop() {
    this.operations.cancelAll();
  }
}
