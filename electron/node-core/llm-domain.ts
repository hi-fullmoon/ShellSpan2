import { join } from 'node:path';
import type { CredentialManager } from './credentials.ts';
import type { StorageClient } from './storage.ts';
import {
  declarationTemplate,
  resolveModel,
  validateProviderConfig,
  type ProviderConfig,
} from './llm-catalog.ts';
import { LlmImageStore } from './llm-images.ts';
import { convertV4ToV5, listSessionMigrations } from './llm-migration.ts';
import {
  LlmRouteStore,
  routeModels,
  routeProvider,
  type ModelSelection,
  type ProviderRoute,
} from './llm-routes.ts';
import { listProviderModels } from './llm-runtime.ts';

export class LlmDomain {
  readonly routes: LlmRouteStore;
  readonly images: LlmImageStore;
  readonly ready: Promise<void>;

  constructor(
    storage: StorageClient,
    private readonly credentials: CredentialManager,
    private readonly appData: string,
  ) {
    this.routes = new LlmRouteStore(storage, credentials);
    this.images = new LlmImageStore(appData);
    this.ready = Promise.all([this.routes.ready, this.images.initialize()]).then(() => {});
  }

  async command(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    await this.ready;
    switch (name) {
      case 'ai_list_routes':
        return this.routes.snapshot();
      case 'ai_save_routes': {
        const input = args.input as {
          routes: ProviderRoute[];
          defaultSelection?: ModelSelection;
          expectedRevision: number;
          secrets?: Record<string, string>;
        };
        return this.routes.save(
          input.routes,
          input.defaultSelection,
          input.expectedRevision,
          input.secrets,
        );
      }
      case 'ai_list_route_models': {
        const snapshot = this.routes.snapshot();
        const route = snapshot.routes.find((item) => item.id === args.routeId);
        if (!route) throw new Error(`UNKNOWN_ROUTE: ${String(args.routeId)}`);
        return {
          revision: snapshot.revision,
          models: Object.keys(routeModels(route))
            .sort()
            .map((modelId) => resolveModel(routeProvider(route, { routeId: route.id, modelId }))),
        };
      }
      case 'ai_resolve_selection': {
        const input = args.input as { selection: ModelSelection; expectedRevision: number };
        const route = this.routes.route(input.selection.routeId);
        if (route.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT');
        return resolveModel(routeProvider(route, input.selection));
      }
      case 'ai_list_models': {
        const provider = args.provider as ProviderConfig;
        validateProviderConfig(provider, false);
        const temporary = provider.apiKey?.trim() || undefined;
        let apiKey = temporary;
        if (!apiKey) {
          const route = this.routes.snapshot().routes.find((item) => item.id === provider.id);
          if (route) apiKey = await this.routes.credential(route);
          else if (provider.requiresApiKey) throw new Error('MISSING_CREDENTIAL');
        }
        return listProviderModels(provider, apiKey, signal);
      }
      case 'ai_resolve_model': {
        const provider = args.provider as ProviderConfig;
        validateProviderConfig(provider, true);
        return resolveModel(provider);
      }
      case 'ai_model_declaration_template':
        return declarationTemplate(args.provider as ProviderConfig);
      case 'ai_list_session_migrations':
        return listSessionMigrations(this.appData);
      case 'ai_convert_session_v4_to_v5': {
        const sessionId = (args.input as { sessionId: string }).sessionId;
        const source = join(this.appData, 'agent-runtime', 'sessions-v4', `${sessionId}.jsonl`);
        const destination = join(
          this.appData,
          'agent-runtime',
          'sessions-v5',
          `${sessionId}.jsonl`,
        );
        return convertV4ToV5(source, destination);
      }
      default:
        throw new Error(`Unknown LLM command: ${name}`);
    }
  }
}

export const llmCommands = new Set([
  'ai_convert_session_v4_to_v5',
  'ai_list_models',
  'ai_list_route_models',
  'ai_list_routes',
  'ai_list_session_migrations',
  'ai_model_declaration_template',
  'ai_resolve_model',
  'ai_resolve_selection',
  'ai_save_routes',
]);
