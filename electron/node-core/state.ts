import { CancellationRegistry } from './cancellation.ts';
import { HealthCollector } from './health.ts';
import { NodeCorePaths } from './paths.ts';
import { PetdexAdapter } from './petdex.ts';
import { StorageClient } from './storage.ts';
import { CredentialManager } from './credentials.ts';
import { TerminalManager } from './terminal.ts';
import { HostTrustManager } from './host-trust.ts';
import { SshConnector } from './ssh.ts';
import { RemoteFsManager } from './remote-fs.ts';
import { RemoteHealthManager } from './remote-health.ts';
import { PortForwardManager } from './port-forward.ts';
import { PreflightManager } from './preflight.ts';
import { LlmDomain } from './llm-domain.ts';
import { AgentRuntime } from './agent-runtime.ts';
import type { NodeCoreEventSender } from './events.ts';

export type NodeCoreLifecycle = 'starting' | 'ready' | 'stopping' | 'stopped';

export const nodeCoreDomains = new Set([
  'health',
  'local-fs',
  'logs',
  'petdex',
  'storage',
  'credentials',
  'llm',
  'host-trust',
  'terminal',
  'remote-fs',
  'remote-health',
  'port-forward',
  'agent-runtime',
]);

export function enabledNodeCoreDomains(env: NodeJS.ProcessEnv) {
  if (env.SHELLSPAN_NODE_CORE_TEST_MODE === '1')
    return new Set((env.SHELLSPAN_NODE_DOMAINS || '').split(',').filter(Boolean));
  return nodeCoreDomains;
}

/** Process-owned state. Later domains add their registries here, never in Electron Main. */
export class NodeCoreState {
  lifecycle: NodeCoreLifecycle = 'starting';
  readonly requests = new Map<number, AbortController>();
  readonly paths: NodeCorePaths;
  readonly localOperations = new CancellationRegistry();
  readonly health = new HealthCollector();
  readonly storage?: StorageClient;
  petdex?: PetdexAdapter;
  credentials?: CredentialManager;
  terminal?: TerminalManager;
  hostTrust?: HostTrustManager;
  ssh?: SshConnector;
  remoteFs?: RemoteFsManager;
  remoteHealth?: RemoteHealthManager;
  portForwards?: PortForwardManager;
  preflight?: PreflightManager;
  llm?: LlmDomain;
  agent?: AgentRuntime;

  constructor(readonly env: NodeJS.ProcessEnv) {
    this.paths = new NodeCorePaths(env);
    const domains = enabledNodeCoreDomains(env);
    if (
      domains.has('storage') ||
      domains.has('credentials') ||
      domains.has('llm') ||
      domains.has('agent-runtime')
    )
      this.storage = new StorageClient(this.paths.database);
  }

  async initialize(events: NodeCoreEventSender) {
    const domains = enabledNodeCoreDomains(this.env);
    if (this.storage) {
      await this.storage.ready;
      if (domains.has('credentials') || domains.has('llm') || domains.has('agent-runtime')) {
        this.credentials = new CredentialManager(this.env, this.storage);
        await this.credentials.migrateInlineApiKeys();
      }
    }
    if ((domains.has('llm') || domains.has('agent-runtime')) && this.storage && this.credentials) {
      this.llm = new LlmDomain(this.storage, this.credentials, this.paths.appData);
      await this.llm.ready;
    }
    const testEndpoint =
      this.env.SHELLSPAN_NODE_CORE_TEST_MODE === '1'
        ? this.env.SHELLSPAN_PETDEX_TEST_ENDPOINT
        : undefined;
    if (
      ['host-trust', 'terminal', 'remote-fs', 'remote-health', 'port-forward'].some((domain) =>
        domains.has(domain),
      )
    )
      this.hostTrust = new HostTrustManager(this.paths.data);
    if (this.hostTrust) this.ssh = new SshConnector(this.hostTrust, this.credentials);
    if (domains.has('host-trust') && this.hostTrust && this.ssh)
      this.preflight = new PreflightManager(this.hostTrust, this.ssh);
    this.petdex = new PetdexAdapter(this.paths.home, events, testEndpoint);
    if (domains.has('terminal')) this.terminal = new TerminalManager(events, this.ssh);
    if (domains.has('remote-fs') && this.ssh) this.remoteFs = new RemoteFsManager(this.ssh, events);
    if (domains.has('remote-health') && this.ssh)
      this.remoteHealth = new RemoteHealthManager(this.ssh);
    if (domains.has('port-forward') && this.ssh)
      this.portForwards = new PortForwardManager(this.ssh, events);
    if (domains.has('agent-runtime') && this.llm) {
      this.agent = new AgentRuntime(
        this.paths.appData,
        events,
        this.llm,
        this.llm.images,
        this.remoteFs,
        this.ssh,
        this.storage,
      );
      await this.agent.ready;
    }
  }

  begin(id: number) {
    if (this.lifecycle !== 'ready') throw new Error('Node core is unavailable');
    const controller = new AbortController();
    this.requests.set(id, controller);
    return controller.signal;
  }

  finish(id: number) {
    this.requests.delete(id);
  }

  async stop() {
    if (this.lifecycle === 'stopped') return;
    this.lifecycle = 'stopping';
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    this.localOperations.cancelAll();
    this.petdex?.stop();
    await this.terminal?.stop();
    await this.remoteFs?.stop();
    this.remoteHealth?.stop();
    this.preflight?.stop();
    await this.portForwards?.stopAll();
    await this.agent?.stop();
    await this.storage?.stop();
  }
}
