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
import {
  listProviderModels,
  prepareRequestSnapshot,
  streamProvider,
  type StreamDelta,
} from './llm-runtime.ts';

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

  /** Secret-free preparation plus the Stage 5 streaming adapter used by Agent Runtime. */
  async prepareAgent(
    selection: ModelSelection,
    body: Record<string, unknown>,
    images: Parameters<typeof prepareRequestSnapshot>[4] = [],
  ) {
    await this.ready;
    const route = this.routes.route(selection.routeId);
    const provider = routeProvider(route, selection);
    const providerBody = agentProviderBody(provider.kind, provider.model, body);
    return {
      provider,
      route,
      body: providerBody,
      prepared: prepareRequestSnapshot(provider, route, providerBody, 'agent-turn', images),
    };
  }

  /** Secret-free preparation plus the Stage 5 streaming adapter used by Agent Runtime. */
  async streamAgent(
    selection: ModelSelection,
    body: Record<string, unknown>,
    images: Parameters<typeof prepareRequestSnapshot>[4],
    signal: AbortSignal,
    emit: (delta: StreamDelta) => void,
  ) {
    await this.ready;
    const preparedAgent = await this.prepareAgent(selection, body, images);
    const { route, provider, prepared } = preparedAgent;
    const apiKey = await this.routes.credential(route);
    const response = await streamProvider({
      provider,
      apiKey,
      body: preparedAgent.body,
      signal,
      timeouts: route.timeouts,
      retryPolicy: route.retryPolicy,
      emit,
    });
    return { provider, route, prepared, response };
  }
}

function agentProviderBody(
  kind: ProviderConfig['kind'],
  model: string,
  input: Record<string, unknown>,
) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const tools = Array.isArray(input.tools) ? input.tools : [];
  if (kind === 'openAi') {
    return {
      model,
      input: messages,
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: 'function',
              name: (tool as Record<string, unknown>).name,
              description: (tool as Record<string, unknown>).description,
              parameters: (tool as Record<string, unknown>).inputSchema,
            })),
          }
        : {}),
    };
  }
  if (kind === 'anthropicMessages') {
    return {
      model,
      messages,
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              name: (tool as Record<string, unknown>).name,
              description: (tool as Record<string, unknown>).description,
              input_schema: (tool as Record<string, unknown>).inputSchema,
            })),
          }
        : {}),
    };
  }
  return {
    model,
    messages,
    stream: true,
    ...(tools.length
      ? {
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: (tool as Record<string, unknown>).name,
              description: (tool as Record<string, unknown>).description,
              parameters: (tool as Record<string, unknown>).inputSchema,
            },
          })),
        }
      : {}),
  };
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
