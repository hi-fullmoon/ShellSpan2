import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import manifest from './contracts/v1/manifest.json';
import type {
  BackendKind,
  CoreBackend,
  CoreBackendEvents,
  CoreRequestType,
} from './core-backend.ts';
import type { CoreReady, CoreResponse } from './types.ts';

export type CanaryMode = BackendKind | 'compare';
export const stageTwoNodeDomains = ['health', 'local-fs', 'logs', 'petdex'] as const;
export const stageThreeNodeDomains = ['storage', 'credentials'] as const;
export const stageFourNodeDomains = [
  'host-trust',
  'terminal',
  'remote-fs',
  'remote-health',
  'port-forward',
] as const;

const domainNames = new Set(Object.keys(manifest.domains));
const commandMetadata = new Map(manifest.commands.map((command) => [command.name, command]));
const canaryCommand = 'read_text_file';
const canary = commandMetadata.get(canaryCommand)!;

if (canary.stateful || canary.mutates)
  throw new Error('The Node Core canary must remain stateless and read-only');

export function parseBackendConfig(value = '') {
  const routes = new Map<string, BackendKind>(
    [...stageTwoNodeDomains, ...stageThreeNodeDomains, ...stageFourNodeDomains].map(
      (domain) => [domain, 'node'] as const,
    ),
  );
  if (!value.trim()) return routes;
  const configured = new Set<string>();
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    const [domain, backend, extra] = entry.split(':');
    if (!domain || !backend || extra || !domainNames.has(domain))
      throw new Error(`Invalid Core backend route: ${entry}`);
    if (backend !== 'rust' && backend !== 'node')
      throw new Error(`Invalid Core backend: ${backend}`);
    if (configured.has(domain)) throw new Error(`Duplicate Core backend domain: ${domain}`);
    configured.add(domain);
    routes.set(domain, backend);
  }
  return routes;
}

export function parseCanaryMode(value?: string): CanaryMode | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'rust' || value === 'node' || value === 'compare') return value;
  throw new Error(`Invalid Core canary mode: ${value}`);
}

/** Domain router. The sole command override is the frozen, stateless read-only canary. */
export class CoreBackendRouter extends EventEmitter<CoreBackendEvents> implements CoreBackend {
  readonly kind = 'router' as const;
  readonly ready: Promise<CoreReady>;
  private stoppingPromise?: Promise<void>;
  private readonly routes: Map<string, BackendKind>;

  constructor(
    readonly rust: CoreBackend,
    readonly node: CoreBackend,
    routes: ReadonlyMap<string, BackendKind> = new Map(),
    readonly canaryMode?: CanaryMode,
  ) {
    super();
    this.routes = new Map(routes);
    for (const domain of this.routes.keys())
      if (!domainNames.has(domain)) throw new Error(`Unknown Core backend domain: ${domain}`);
    if ((this.routes.get('storage') ?? 'rust') !== (this.routes.get('credentials') ?? 'rust'))
      throw new Error('storage and credentials backends must be selected together');
    const stageFourOwners = new Set(
      stageFourNodeDomains.map((domain) => this.routes.get(domain) ?? 'rust'),
    );
    if (stageFourOwners.size !== 1)
      throw new Error('Stage 4 connection backends must be selected together');
    if (stageFourOwners.has('node') && (this.routes.get('credentials') ?? 'rust') !== 'node')
      throw new Error('Node connection backends require Node credentials');
    this.ready = Promise.all([rust.ready, node.ready]).then(() => ({
      type: 'ready',
      protocol: 1,
      terminalChannel: true,
    }));
    this.ready.catch(() => {});
    for (const backend of [rust, node])
      for (const event of ['log', 'event', 'initializing', 'stopped', 'exit', 'failure'] as const)
        backend.on(event, (...args: CoreBackendEvents[typeof event]) => {
          if (backend === rust && event === 'event')
            this.bridgeRustEvent(args[0] as string, args[1]);
          this.emit(event, ...args);
        });
  }

  get stopping() {
    return Boolean(this.stoppingPromise);
  }

  backendFor(command: string) {
    const metadata = commandMetadata.get(command);
    if (!metadata) throw new Error(`Unknown desktop command: ${command}`);
    const kind =
      command === canaryCommand && this.canaryMode !== undefined && this.canaryMode !== 'compare'
        ? this.canaryMode
        : (this.routes.get(metadata.domain) ?? 'rust');
    return kind === 'node' ? this.node : this.rust;
  }

  private async compare(
    operation: 'invoke' | 'validate',
    command: string,
    args: object,
  ): Promise<CoreResponse> {
    const [rust, node] = await Promise.all([
      this.rust[operation](command, args),
      this.node[operation](command, args),
    ]);
    if (!isDeepStrictEqual(rust, node)) {
      this.emit('log', {
        level: 'error',
        target: 'core-router',
        message: `Rust/Node canary mismatch for ${command}`,
      });
      return { ok: false, error: `Rust/Node canary mismatch for ${command}` };
    }
    return rust;
  }

  private petdexUsesNode() {
    return (this.routes.get('petdex') ?? 'rust') === 'node';
  }

  private bridgeRustEvent(event: string, payload: unknown) {
    if (event !== '__core-petdex-activity') return;
    const value = payload as { kind?: string; operationId?: string } | undefined;
    if (typeof value?.kind === 'string') this.notifyPetdex(value.kind, value.operationId);
  }

  private notifyPetdex(kind: string, operationId: unknown) {
    if (!this.petdexUsesNode() || typeof operationId !== 'string') return;
    void this.node.invoke('__petdex_notify', { kind, operationId }).catch(() => {});
  }

  invoke(command: string, args: object = {}, type: CoreRequestType = 'request') {
    if (type !== 'request') return this.rust.invoke(command, args, type);
    if (command === canaryCommand && this.canaryMode === 'compare')
      return this.compare('invoke', command, args);
    return this.backendFor(command).invoke(command, args);
  }

  validate(command: string, args: object = {}) {
    if (command === canaryCommand && this.canaryMode === 'compare')
      return this.compare('validate', command, args);
    return this.backendFor(command).validate(command, args);
  }

  pauseTerminalEvents() {
    this.rust.pauseTerminalEvents();
    this.node.pauseTerminalEvents();
  }

  resumeTerminalEvents() {
    this.rust.resumeTerminalEvents();
    this.node.resumeTerminalEvents();
  }

  stop() {
    if (!this.stoppingPromise)
      this.stoppingPromise = Promise.all([this.rust.stop(), this.node.stop()]).then(() => {});
    return this.stoppingPromise;
  }
}

export { canaryCommand, commandMetadata, domainNames };
