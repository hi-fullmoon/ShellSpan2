import { randomUUID } from 'node:crypto';
import type { CredentialManager } from './credentials.ts';
import type { StorageClient } from './storage.ts';
import {
  adapterId,
  defaultRetryPolicy,
  legacyProfile,
  presetModels,
  resolveModel,
  validateModelDefinition,
  validateProviderConfig,
  validateProviderId,
  validateRetryPolicy,
  type ModelDefinition,
  type ProviderConfig,
  type ProviderKind,
  type ResolvedModel,
  type RetryPolicy,
} from './llm-catalog.ts';

export type ModelSelection = { routeId: string; modelId: string; reasoningEffort?: string };
export type RouteAuth = { kind: 'none' } | { kind: 'keychain'; reference: string };
export type RouteTimeouts = {
  requestHeadersMs: number;
  firstByteMs: number;
  streamIdleMs: number;
};
export type ProviderRoute = {
  id: string;
  revision: number;
  displayName: string;
  adapterId: 'responses' | 'chat-completions' | 'ollama' | 'anthropic-messages';
  baseUrl: string;
  auth: RouteAuth;
  replayDomainId: string;
  presetId?: string | null;
  models?: Record<string, ModelDefinition> | null;
  modelOverrides?: Record<string, ModelDefinition> | null;
  defaults?: ModelSelection | null;
  retryPolicy: RetryPolicy;
  timeouts: RouteTimeouts;
};
export type MigrationIssue = { original: unknown; error: string };
export type RouteSnapshot = {
  schemaVersion: number;
  revision: number;
  routes: ProviderRoute[];
  defaultSelection: ModelSelection | null;
  migrationComplete: boolean;
  migrationIssues: MigrationIssue[];
};

const defaultTimeouts: RouteTimeouts = {
  requestHeadersMs: 30_000,
  firstByteMs: 30_000,
  streamIdleMs: 300_000,
};

function routeKind(route: ProviderRoute): ProviderKind {
  const kind = {
    responses: 'openAi',
    'chat-completions': 'openAiCompatible',
    ollama: 'ollama',
    'anthropic-messages': 'anthropicMessages',
  }[route.adapterId] as ProviderKind | undefined;
  if (!kind) throw new Error('UNKNOWN_ADAPTER');
  return kind;
}

export function routeModels(route: ProviderRoute) {
  if (route.models && route.modelOverrides)
    throw new Error('INVALID_OVERRIDE: models and modelOverrides are mutually exclusive');
  const kind = routeKind(route);
  const models = route.models
    ? structuredClone(route.models)
    : presetModels(
        route.presetId ||
          (() => {
            throw new Error('UNKNOWN_PROFILE');
          })(),
        kind,
      );
  if (route.modelOverrides) {
    for (const [id, definition] of Object.entries(route.modelOverrides)) {
      if (!Object.hasOwn(models, id)) throw new Error(`INVALID_OVERRIDE: ${id}`);
      models[id] = structuredClone(definition);
    }
  }
  if (!Object.keys(models).length) throw new Error('UNKNOWN_MODEL: empty route catalog');
  for (const [id, definition] of Object.entries(models))
    validateModelDefinition(id, definition, kind);
  return models;
}

function normalizedRoute(route: ProviderRoute): ProviderRoute {
  return {
    ...structuredClone(route),
    presetId: route.presetId ?? null,
    models: route.models ?? null,
    modelOverrides: route.modelOverrides ?? null,
    defaults: route.defaults ?? null,
  };
}

export function routeProvider(route: ProviderRoute, selection: ModelSelection): ProviderConfig {
  if (selection.routeId !== route.id) throw new Error('UNKNOWN_ROUTE');
  const definition = routeModels(route)[selection.modelId];
  if (!definition) throw new Error('UNKNOWN_MODEL');
  const kind = routeKind(route);
  const provider: ProviderConfig = {
    id: route.id,
    kind,
    baseUrl: route.baseUrl,
    model: selection.modelId,
    requiresApiKey: route.auth.kind !== 'none',
    profile:
      kind === 'openAi'
        ? 'openai'
        : kind === 'ollama'
          ? 'ollama'
          : kind === 'anthropicMessages'
            ? 'anthropic'
            : 'generic',
    modelDefinition: definition,
    retryPolicy: route.retryPolicy,
  };
  if (selection.reasoningEffort !== undefined) provider.reasoningEffort = selection.reasoningEffort;
  validateProviderConfig(provider, true);
  return provider;
}

export function validateRoute(route: ProviderRoute) {
  validateProviderId(route.id);
  validateRetryPolicy(route.retryPolicy);
  if (!route.displayName.trim() || !route.replayDomainId) throw new Error('INVALID_ROUTE');
  if (
    !route.timeouts ||
    [route.timeouts.firstByteMs, route.timeouts.requestHeadersMs, route.timeouts.streamIdleMs].some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > 3_600_000,
    )
  )
    throw new Error('INVALID_TIMEOUT');
  if (route.auth.kind === 'keychain' && !route.auth.reference)
    throw new Error('MISSING_CREDENTIAL');
  if (routeKind(route) === 'anthropicMessages' && route.auth.kind !== 'keychain')
    throw new Error('MISSING_CREDENTIAL');
  for (const modelId of Object.keys(routeModels(route)))
    routeProvider(route, { routeId: route.id, modelId });
  if (route.defaults) routeProvider(route, route.defaults);
}

export function validateSnapshot(snapshot: RouteSnapshot) {
  if (snapshot.schemaVersion !== 1) throw new Error('UNSUPPORTED_ROUTE_VERSION');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0)
    throw new Error('INVALID_ROUTE');
  const ids = new Set<string>();
  for (const route of snapshot.routes) {
    if (ids.has(route.id)) throw new Error('DUPLICATE_ROUTE');
    ids.add(route.id);
    validateRoute(route);
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function migrateLegacyRoutes(entries: Array<[string, string]>): {
  snapshot: RouteSnapshot;
  backup: string;
} {
  const backup = entries.find(([key]) => key === 'ai.providers')?.[1] || '[]';
  let items: unknown;
  try {
    items = JSON.parse(backup);
  } catch (error) {
    throw new Error(`INVALID_LEGACY_CONFIGURATION: ${errorText(error)}`);
  }
  if (!Array.isArray(items)) throw new Error('INVALID_LEGACY_CONFIGURATION: expected an array');
  const snapshot: RouteSnapshot = {
    schemaVersion: 1,
    revision: 1,
    routes: [],
    defaultSelection: null,
    migrationComplete: true,
    migrationIssues: [],
  };
  for (const value of items) {
    const original = structuredClone(value);
    if (original && typeof original === 'object' && !Array.isArray(original))
      delete (original as Record<string, unknown>).apiKey;
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid legacy provider');
      const clean = { ...(value as Record<string, unknown>) };
      delete clean.apiKey;
      const displayName = typeof clean.name === 'string' ? clean.name : '';
      delete clean.name;
      delete clean.preset;
      delete clean.enabled;
      delete clean.hasApiKey;
      const provider = clean as unknown as ProviderConfig;
      validateProviderConfig(provider, true);
      const model = resolveModel(provider);
      const selection: ModelSelection = { routeId: provider.id, modelId: provider.model };
      if (provider.reasoningEffort !== undefined)
        selection.reasoningEffort = provider.reasoningEffort;
      const route: ProviderRoute = {
        id: provider.id,
        revision: 1,
        displayName: displayName || provider.id,
        adapterId: adapterId(provider.kind),
        baseUrl: provider.baseUrl,
        auth: provider.requiresApiKey
          ? { kind: 'keychain', reference: provider.id }
          : { kind: 'none' },
        replayDomainId: randomUUID(),
        presetId: model.profile,
        models: { [provider.model]: modelDefinition(model) },
        modelOverrides: null,
        defaults: selection,
        retryPolicy: structuredClone(provider.retryPolicy || defaultRetryPolicy),
        timeouts: structuredClone(defaultTimeouts),
      };
      validateRoute(route);
      if (snapshot.routes.some((existing) => existing.id === route.id))
        throw new Error('DUPLICATE_ROUTE');
      snapshot.routes.push(route);
    } catch (error) {
      snapshot.migrationIssues.push({ original, error: errorText(error) });
    }
  }
  const rawDefault = entries.find(([key]) => key === 'ai.defaultProviderId')?.[1];
  let defaultId: string | undefined;
  if (rawDefault) {
    try {
      const parsed = JSON.parse(rawDefault);
      if (typeof parsed === 'string') defaultId = parsed;
    } catch {}
  }
  if (defaultId)
    snapshot.defaultSelection =
      snapshot.routes.find((route) => route.id === defaultId)?.defaults ||
      (() => {
        const item = items.find(
          (entry) =>
            entry &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).id === defaultId,
        ) as Record<string, unknown> | undefined;
        return typeof item?.model === 'string' ? { routeId: defaultId, modelId: item.model } : null;
      })();
  return { snapshot, backup };
}

function modelDefinition(model: ResolvedModel): ModelDefinition {
  const {
    catalogVersion: _,
    routeId: _route,
    providerId: _provider,
    profile: _profile,
    kind: _kind,
    modelId: _model,
    source: _source,
    capacityPolicy: _policy,
    ...definition
  } = model;
  return definition;
}

function selected<T extends object>(value: T, keys: Array<keyof T>) {
  return JSON.stringify(keys.map((key) => value[key]));
}

export class LlmRouteStore {
  private current!: RouteSnapshot;
  private queue: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(
    private readonly storage: StorageClient,
    private readonly credentials: CredentialManager,
  ) {
    this.ready = this.open();
  }

  private async open() {
    const entries = await this.storage.invoke<Array<[string, string]>>('load_preferences');
    const raw = entries.find(([key]) => key === 'llm.routes.v1')?.[1];
    if (raw !== undefined) {
      try {
        this.current = JSON.parse(raw) as RouteSnapshot;
      } catch (error) {
        throw new Error(`INVALID_ROUTE_DOCUMENT: ${errorText(error)}`);
      }
    } else {
      const migrated = migrateLegacyRoutes(entries);
      try {
        await this.storage.invoke('__db_commit_llm_routes', {
          expected: null,
          document: JSON.stringify(migrated.snapshot),
          backup: migrated.backup,
        });
        this.current = migrated.snapshot;
      } catch (error) {
        if (errorText(error) !== 'REVISION_CONFLICT') throw error;
        const latest = await this.storage.invoke<Array<[string, string]>>('load_preferences');
        const concurrent = latest.find(([key]) => key === 'llm.routes.v1')?.[1];
        if (!concurrent) throw error;
        this.current = JSON.parse(concurrent) as RouteSnapshot;
      }
    }
    validateSnapshot(this.current);
    await this.recoverCredentials();
  }

  snapshot() {
    return structuredClone(this.current);
  }

  route(id: string) {
    const route = this.current.routes.find((candidate) => candidate.id === id);
    if (!route) throw new Error(`UNKNOWN_ROUTE: ${id}`);
    return structuredClone(route);
  }

  async credential(route: ProviderRoute) {
    if (route.auth.kind === 'none') return undefined;
    const value = (await this.credentials.aiCredentialGet(route.auth.reference))?.trim();
    if (!value) throw new Error('MISSING_CREDENTIAL');
    return value;
  }

  save(
    routes: ProviderRoute[],
    defaultSelection: ModelSelection | null | undefined,
    expectedRevision: number,
    secrets: Record<string, string> = {},
  ) {
    const task = this.queue.then(() =>
      this.saveNow(routes, defaultSelection ?? null, expectedRevision, secrets),
    );
    this.queue = task.catch(() => {});
    return task;
  }

  private async saveNow(
    routes: ProviderRoute[],
    defaultSelection: ModelSelection | null,
    expectedRevision: number,
    secrets: Record<string, string>,
  ) {
    if (this.current.revision !== expectedRevision) throw new Error('REVISION_CONFLICT');
    if (!Number.isSafeInteger(expectedRevision + 1)) throw new Error('REVISION_EXHAUSTED');
    const candidate: RouteSnapshot = {
      schemaVersion: 1,
      revision: expectedRevision + 1,
      routes: routes.map(normalizedRoute),
      defaultSelection: structuredClone(defaultSelection),
      migrationComplete: this.current.migrationComplete,
      migrationIssues: structuredClone(this.current.migrationIssues),
    };
    for (const id of Object.keys(secrets))
      if (!candidate.routes.some((route) => route.id === id)) throw new Error('UNKNOWN_ROUTE');
    const staged: Array<[string, string]> = [];
    const identityKeys: Array<keyof ProviderRoute> = [
      'baseUrl',
      'adapterId',
      'auth',
      'presetId',
      'models',
      'modelOverrides',
    ];
    const changeKeys: Array<keyof ProviderRoute> = [
      'displayName',
      ...identityKeys,
      'defaults',
      'retryPolicy',
      'timeouts',
    ];
    for (const route of candidate.routes) {
      const old = this.current.routes.find((item) => item.id === route.id);
      if (
        old &&
        JSON.stringify(route.auth) !== JSON.stringify(old.auth) &&
        route.auth.kind !== 'none' &&
        !Object.hasOwn(secrets, route.id)
      )
        throw new Error('INVALID_CREDENTIAL_REFERENCE');
      if (!old && route.auth.kind !== 'none' && !Object.hasOwn(secrets, route.id))
        throw new Error('MISSING_CREDENTIAL');
      const changed = !old || selected(old, changeKeys) !== selected(route, changeKeys);
      const identityChanged = !old || selected(old, identityKeys) !== selected(route, identityKeys);
      route.revision = old
        ? changed || Object.hasOwn(secrets, route.id)
          ? Math.min(Number.MAX_SAFE_INTEGER, old.revision + 1)
          : old.revision
        : 1;
      route.replayDomainId =
        identityChanged || Object.hasOwn(secrets, route.id) ? randomUUID() : old!.replayDomainId;
      if (Object.hasOwn(secrets, route.id)) {
        if (!secrets[route.id].trim()) throw new Error('MISSING_CREDENTIAL');
        const reference = `llm-${randomUUID()}`;
        route.auth = { kind: 'keychain', reference };
        staged.push([reference, secrets[route.id]]);
      }
    }
    validateSnapshot(candidate);
    if (candidate.defaultSelection)
      routeProvider(
        candidate.routes.find((route) => route.id === candidate.defaultSelection!.routeId) ||
          (() => {
            throw new Error(`UNKNOWN_ROUTE: ${candidate.defaultSelection!.routeId}`);
          })(),
        candidate.defaultSelection,
      );
    const journalKeys = staged.map(([reference]) => `llm.pendingCredential.${reference}`);
    for (const key of journalKeys)
      await this.storage.invoke('save_preferences', { entries: [[key, 'pending']] });
    try {
      for (const [reference, secret] of staged)
        await this.credentials.aiCredentialSet(reference, secret);
    } catch (error) {
      await Promise.all(
        staged.map(([reference]) => this.credentials.aiCredentialDelete(reference).catch(() => {})),
      );
      if (journalKeys.length)
        await this.storage.invoke('__db_delete_preferences', { keys: journalKeys }).catch(() => {});
      throw error;
    }
    try {
      await this.storage.invoke('__db_commit_llm_routes', {
        expected: expectedRevision,
        document: JSON.stringify(candidate),
      });
    } catch (error) {
      await Promise.all(
        staged.map(([reference]) => this.credentials.aiCredentialDelete(reference).catch(() => {})),
      );
      throw error;
    }
    this.current = candidate;
    if (journalKeys.length)
      await this.storage.invoke('__db_delete_preferences', { keys: journalKeys }).catch(() => {});
    return this.snapshot();
  }

  private async recoverCredentials() {
    const entries = await this.storage.invoke<Array<[string, string]>>('load_preferences');
    for (const [key] of entries) {
      if (!key.startsWith('llm.pendingCredential.')) continue;
      const reference = key.slice('llm.pendingCredential.'.length);
      const referenced = this.current.routes.some(
        (route) => route.auth.kind === 'keychain' && route.auth.reference === reference,
      );
      if (!referenced) await this.credentials.aiCredentialDelete(reference);
      await this.storage.invoke('__db_delete_preferences', { keys: [key] });
    }
  }
}
