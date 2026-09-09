import { CancellationRegistry } from './cancellation.ts';
import { HealthCollector } from './health.ts';
import { NodeCorePaths } from './paths.ts';
import { PetdexAdapter } from './petdex.ts';
import { StorageClient } from './storage.ts';
import { CredentialManager } from './credentials.ts';
import type { NodeCoreEventSender } from './events.ts';

export type NodeCoreLifecycle = 'starting' | 'ready' | 'stopping' | 'stopped';

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

  constructor(readonly env: NodeJS.ProcessEnv) {
    this.paths = new NodeCorePaths(env);
    const domains = new Set((env.SHELLSPAN_NODE_DOMAINS || '').split(',').filter(Boolean));
    if (domains.has('storage') || domains.has('credentials'))
      this.storage = new StorageClient(this.paths.database);
  }

  async initialize(events: NodeCoreEventSender) {
    if (this.storage) {
      await this.storage.ready;
      const domains = new Set((this.env.SHELLSPAN_NODE_DOMAINS || '').split(',').filter(Boolean));
      if (domains.has('credentials')) {
        this.credentials = new CredentialManager(this.env, this.storage);
        await this.credentials.migrateInlineApiKeys();
      }
    }
    const testEndpoint =
      this.env.SHELLSPAN_NODE_CORE_TEST_MODE === '1'
        ? this.env.SHELLSPAN_PETDEX_TEST_ENDPOINT
        : undefined;
    this.petdex = new PetdexAdapter(this.paths.home, events, testEndpoint);
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
    await this.storage?.stop();
  }
}
