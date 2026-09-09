import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProviderKind = 'ollama' | 'openAi' | 'openAiCompatible' | 'anthropicMessages';
export type Support = 'supported' | 'unsupported' | 'unknown';
export type ReasoningOption = { id: string; displayName: string; wireValue?: unknown };
export type ModelCompat = {
  protocol: ProviderKind;
  cumulativeStream: boolean;
  supportsStreamUsage: boolean;
  nativeReasoning: boolean;
  splitReasoning: boolean;
  replayReasoningContent: boolean;
  thinkTagFallback: boolean;
  parallelToolCalls: boolean;
  strictSchema: boolean;
  preservesReasoningAcrossTurns: boolean;
  reasoningEncoding:
    | 'none'
    | 'responses'
    | 'enableThinking'
    | 'thinking'
    | 'adaptive'
    | 'thinkingEffort'
    | 'effort'
    | 'ollama'
    | 'anthropicAdaptive';
  clearThinking: boolean;
  defaultThinking: boolean;
};
export type VisionBudget = {
  maxRequestImages: number;
  maxRequestImageBytes: number;
  reservedTokensPerImage: number;
  imageTokenBudgetPolicy: string;
};
export type ModelDefinition = {
  contextWindow: number;
  maxOutputTokens: number;
  toolCalling: Support;
  textInput: Support;
  imageInput: Support;
  reasoning: ReasoningOption[];
  compat: ModelCompat;
  vision?: VisionBudget;
};
export type RetryPolicy = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  maxServerDelayMs: number;
  jitterRatio: number;
};
export type ProviderConfig = {
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  requiresApiKey: boolean;
  apiKey?: string;
  profile?: string;
  reasoningEffort?: string;
  modelDefinition?: ModelDefinition;
  retryPolicy?: RetryPolicy;
  routeRevision?: number;
};
export type ResolvedModel = {
  catalogVersion: number;
  routeId: string;
  providerId: string;
  profile: string;
  kind: ProviderKind;
  modelId: string;
  source: 'builtinCatalog' | 'userDeclaration';
  capacityPolicy: 'providerPublished2026-09-05' | 'conservativeApplicationBudget';
} & ModelDefinition;

type Preset = {
  kind: ProviderKind;
  legacyHosts: string[];
  compat: ModelCompat;
  models: Record<string, ModelDefinition>;
};
type Catalog = { version: number; policy: string; presets: Record<string, Preset> };

const catalog = JSON.parse(readFileSync(join(__dirname, 'llm-catalog.json'), 'utf8')) as Catalog;

if (catalog.version !== 1 || !catalog.policy) throw new Error('Invalid bundled LLM catalog');

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 4_000,
  maxServerDelayMs: 30_000,
  jitterRatio: 0.2,
};

export function validateProviderId(id: string) {
  if (!id || id.length > 80 || !/^[A-Za-z0-9_.-]+$/.test(id))
    throw new Error('AI provider id is invalid');
}

export function validateRetryPolicy(policy: RetryPolicy) {
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 8 ||
    !Number.isSafeInteger(policy.initialDelayMs) ||
    !Number.isSafeInteger(policy.maxDelayMs) ||
    !Number.isSafeInteger(policy.maxServerDelayMs) ||
    policy.initialDelayMs < 0 ||
    policy.initialDelayMs > policy.maxDelayMs ||
    policy.maxDelayMs > 300_000 ||
    policy.maxServerDelayMs < 0 ||
    policy.maxServerDelayMs > 300_000 ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  )
    throw new Error(
      'AI retry policy is invalid: attempts 1..8, delays 0..300000 ms, initial <= maximum, jitter 0..1',
    );
}

function providerUrl(provider: ProviderConfig) {
  let url: URL;
  try {
    url = new URL(provider.baseUrl.trim());
  } catch {
    throw new Error('AI provider URL is invalid');
  }
  if (url.username || url.password) throw new Error('AI provider URL cannot contain credentials');
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
    )
  )
    throw new Error('AI provider URL must use HTTPS; HTTP is only allowed for localhost');
  return url;
}

export function legacyProfile(provider: ProviderConfig) {
  if (provider.profile) return provider.profile;
  if (provider.kind === 'openAi') return 'openai';
  if (provider.kind === 'ollama') return 'ollama';
  if (provider.kind === 'anthropicMessages') return 'anthropic';
  let host = '';
  try {
    host = new URL(provider.baseUrl.trim()).hostname.toLowerCase();
  } catch {}
  return (
    Object.entries(catalog.presets).find(([, preset]) =>
      preset.legacyHosts.some((candidate) =>
        candidate.startsWith('.') ? host.endsWith(candidate) : host === candidate,
      ),
    )?.[0] || 'generic'
  );
}

export function validateModelDefinition(
  id: string,
  definition: ModelDefinition,
  kind: ProviderKind,
) {
  if (!id || id.trim() !== id)
    throw new Error('UNKNOWN_MODEL: model ID must be nonempty and exact');
  if (
    !Number.isSafeInteger(definition.contextWindow) ||
    !Number.isSafeInteger(definition.maxOutputTokens) ||
    definition.contextWindow <= 0 ||
    definition.maxOutputTokens <= 0 ||
    definition.maxOutputTokens > definition.contextWindow
  )
    throw new Error(
      'UNSUPPORTED_OPTION: token counts must be positive exact JSON integers; output must not exceed context',
    );
  const compat = definition.compat;
  if (!compat || compat.protocol !== kind)
    throw new Error('UNSUPPORTED_OPTION: compat protocol mismatch');
  const encodings: Record<ProviderKind, string[]> = {
    openAi: ['none', 'responses'],
    ollama: ['none', 'ollama'],
    openAiCompatible: [
      'none',
      'enableThinking',
      'thinking',
      'adaptive',
      'thinkingEffort',
      'effort',
    ],
    anthropicMessages: ['none', 'anthropicAdaptive'],
  };
  if (
    !encodings[kind].includes(compat.reasoningEncoding) ||
    (compat.reasoningEncoding === 'none' && definition.reasoning.length > 0) ||
    (!compat.nativeReasoning && definition.reasoning.length > 0)
  )
    throw new Error('UNSUPPORTED_OPTION: incompatible reasoning encoding');
  if (
    kind !== 'openAiCompatible' &&
    (compat.cumulativeStream ||
      compat.splitReasoning ||
      compat.clearThinking ||
      compat.defaultThinking)
  )
    throw new Error('UNSUPPORTED_OPTION: chat compatibility requires chat-completions');
  if (
    kind === 'ollama' &&
    (compat.strictSchema ||
      compat.parallelToolCalls ||
      compat.replayReasoningContent ||
      !compat.supportsStreamUsage)
  )
    throw new Error('UNSUPPORTED_OPTION: unsupported Ollama compatibility switch');
  if (
    kind === 'openAi' &&
    (!compat.nativeReasoning ||
      compat.replayReasoningContent ||
      compat.thinkTagFallback ||
      !compat.supportsStreamUsage)
  )
    throw new Error('UNSUPPORTED_OPTION: unsupported Responses compatibility switch');
  if (
    kind === 'anthropicMessages' &&
    (compat.cumulativeStream ||
      !compat.supportsStreamUsage ||
      !compat.nativeReasoning ||
      compat.splitReasoning ||
      compat.replayReasoningContent ||
      compat.thinkTagFallback ||
      !compat.parallelToolCalls ||
      compat.strictSchema ||
      !compat.preservesReasoningAcrossTurns ||
      compat.clearThinking ||
      compat.defaultThinking)
  )
    throw new Error('UNSUPPORTED_OPTION: unsupported Anthropic Messages compatibility switch');
  if (
    (compat.clearThinking || compat.defaultThinking) &&
    !['thinking', 'thinkingEffort'].includes(compat.reasoningEncoding)
  )
    throw new Error('UNSUPPORTED_OPTION: thinking retention requires a thinking encoding');
  const ids = new Set<string>();
  for (const option of definition.reasoning) {
    if (
      !option.id ||
      !/^[A-Za-z0-9_-]+$/.test(option.id) ||
      !option.displayName?.trim() ||
      ids.has(option.id)
    )
      throw new Error('UNSUPPORTED_OPTION: invalid or duplicate reasoning ID');
    ids.add(option.id);
  }
  if ((definition.imageInput === 'supported') !== Boolean(definition.vision))
    throw new Error('UNSUPPORTED_OPTION: supported images require an explicit budget');
  if (definition.vision) {
    const vision = definition.vision;
    if (
      !Number.isInteger(vision.maxRequestImages) ||
      vision.maxRequestImages < 1 ||
      vision.maxRequestImages > 20 ||
      !Number.isSafeInteger(vision.maxRequestImageBytes) ||
      vision.maxRequestImageBytes < 1 ||
      vision.maxRequestImageBytes > 20 * 1024 * 1024 ||
      !Number.isSafeInteger(vision.reservedTokensPerImage) ||
      vision.reservedTokensPerImage < 1 ||
      vision.reservedTokensPerImage > definition.contextWindow ||
      !vision.imageTokenBudgetPolicy?.trim()
    )
      throw new Error('UNSUPPORTED_OPTION: invalid image budget');
  }
}

export function validateProviderConfig(provider: ProviderConfig, requireModel: boolean) {
  validateProviderId(provider.id);
  if (provider.retryPolicy) validateRetryPolicy(provider.retryPolicy);
  const preset = catalog.presets[legacyProfile(provider)];
  if (!preset) throw new Error('UNKNOWN_PROFILE: Unknown provider profile');
  if (preset.kind !== provider.kind)
    throw new Error('UNSUPPORTED_OPTION: Provider profile does not match protocol');
  providerUrl(provider);
  if (requireModel) {
    if (!provider.model.trim()) throw new Error('AI model cannot be empty');
    resolveModel(provider);
  }
}

export function endpointUrl(provider: ProviderConfig, path: string) {
  validateProviderConfig(provider, false);
  const url = providerUrl(provider);
  const host = url.hostname.toLowerCase();
  let base = url.pathname.replace(/\/$/, '');
  let hadEndpoint = false;
  for (const suffix of [
    '/chat/completions',
    '/responses',
    '/models',
    '/api/chat',
    '/api/tags',
    '/api/show',
    '/messages',
  ]) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      hadEndpoint = true;
      break;
    }
  }
  if (provider.kind === 'openAiCompatible' && host === 'api.deepseek.com' && base === '/v1')
    base = '';
  else if (provider.kind === 'openAiCompatible' && host === 'open.bigmodel.cn') {
    if (!base || base === '/v1') base = '/api/paas/v4';
  } else if (!hadEndpoint && provider.kind !== 'ollama' && !base.endsWith('/v1')) {
    base = `${base}/v1`;
  }
  url.hash = '';
  url.pathname = `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  return url;
}

export function presetModels(id: string, kind: ProviderKind) {
  const preset = catalog.presets[id];
  if (!preset) throw new Error('UNKNOWN_PROFILE');
  if (preset.kind !== kind) throw new Error('UNSUPPORTED_OPTION: preset protocol mismatch');
  return structuredClone(preset.models);
}

export function resolveModel(provider: ProviderConfig): ResolvedModel {
  const profile = legacyProfile(provider);
  const preset = catalog.presets[profile];
  if (!preset) throw new Error('UNKNOWN_PROFILE: Unknown provider profile');
  if (preset.kind !== provider.kind)
    throw new Error('UNSUPPORTED_OPTION: Provider profile does not match protocol');
  const definition = structuredClone(provider.modelDefinition || preset.models[provider.model]);
  if (!definition)
    throw new Error(
      `UNKNOWN_MODEL: declare capacities and capabilities for ${profile}/${provider.model}`,
    );
  validateModelDefinition(provider.model, definition, provider.kind);
  if (
    provider.reasoningEffort &&
    !definition.reasoning.some((option) => option.id === provider.reasoningEffort)
  )
    throw new Error(
      `UNSUPPORTED_REASONING_EFFORT: Unsupported reasoning option for ${profile}/${provider.model}`,
    );
  return {
    catalogVersion: catalog.version,
    routeId: provider.id,
    providerId: provider.id,
    profile,
    kind: provider.kind,
    modelId: provider.model,
    source: provider.modelDefinition ? 'userDeclaration' : 'builtinCatalog',
    capacityPolicy:
      profile === 'anthropic' ? 'providerPublished2026-09-05' : 'conservativeApplicationBudget',
    ...definition,
  };
}

export function declarationTemplate(provider: ProviderConfig): ModelDefinition {
  const profile = legacyProfile(provider);
  const preset = catalog.presets[profile];
  if (!preset) throw new Error('UNKNOWN_PROFILE: Unknown provider profile');
  if (preset.kind !== provider.kind)
    throw new Error('UNSUPPORTED_OPTION: Provider profile does not match protocol');
  return {
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: 'unknown',
    textInput: 'supported',
    imageInput: 'unknown',
    reasoning: [],
    compat: structuredClone(preset.compat),
  };
}

export function adapterId(
  kind: ProviderKind,
): 'responses' | 'chat-completions' | 'ollama' | 'anthropic-messages' {
  return (
    {
      openAi: 'responses',
      openAiCompatible: 'chat-completions',
      ollama: 'ollama',
      anthropicMessages: 'anthropic-messages',
    } as const
  )[kind];
}
