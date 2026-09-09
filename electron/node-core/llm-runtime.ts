import { setTimeout as delay } from 'node:timers/promises';
import { redactDiagnostic } from './redaction.ts';
import {
  defaultRetryPolicy,
  endpointUrl,
  resolveModel,
  validateProviderConfig,
  type ProviderConfig,
  type ProviderKind,
  type RetryPolicy,
  type ResolvedModel,
} from './llm-catalog.ts';
import type { ImageReference } from './llm-images.ts';
import type { ProviderRoute, RouteTimeouts } from './llm-routes.ts';
import { createHash } from 'node:crypto';

const MAX_ERROR_BYTES = 4 * 1024;
const MAX_NON_STREAM_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;

export type ModelUsage = {
  uncachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};
export type ModelContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'toolCall';
      call: {
        callId: string;
        providerCallId?: string;
        name: string;
        arguments: unknown;
      };
    };
export type StreamDelta =
  | { type: 'text'; index: number; text: string }
  | { type: 'reasoning'; index: number; text: string }
  | {
      type: 'toolCall';
      index: number;
      callId?: string;
      nameDelta?: string;
      argumentsDelta?: string;
    }
  | { type: 'usage'; usage: ModelUsage };
export type NormalizedErrorKind =
  | 'cancelled'
  | 'retryable'
  | 'transport'
  | 'timeout'
  | 'emptyResponse'
  | 'protocol'
  | 'contextTooLarge'
  | 'authentication'
  | 'rateLimited'
  | 'terminal';

export class NormalizedModelError extends Error {
  constructor(
    readonly kind: NormalizedErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
  ) {
    super(redactDiagnostic(message));
    this.name = 'NormalizedModelError';
  }
  get retryable() {
    return ['retryable', 'transport', 'timeout', 'emptyResponse', 'rateLimited'].includes(
      this.kind,
    );
  }
  static cancelled() {
    return new NormalizedModelError('cancelled', 'model request cancelled');
  }
}

function integer(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function at(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function providerUsageFromValue(kind: ProviderKind, value: unknown): ModelUsage | undefined {
  const object = value as Record<string, unknown>;
  const raw =
    kind === 'openAi'
      ? at(object, ['response', 'usage']) || object.usage
      : kind === 'openAiCompatible'
        ? object.usage
        : kind === 'anthropicMessages'
          ? object.usage || object
          : object;
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  let input: number | undefined;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let output: number | undefined;
  let reasoning: number | undefined;
  let explicitTotal: number | undefined;
  if (kind === 'openAi') {
    input = integer(usage.input_tokens);
    cacheRead = integer(at(usage, ['input_tokens_details', 'cached_tokens']));
    output = integer(usage.output_tokens);
    reasoning = integer(at(usage, ['output_tokens_details', 'reasoning_tokens']));
    explicitTotal = integer(usage.total_tokens);
  } else if (kind === 'openAiCompatible') {
    input = integer(usage.prompt_tokens);
    cacheRead =
      integer(usage.prompt_cache_hit_tokens) ??
      integer(at(usage, ['prompt_tokens_details', 'cached_tokens']));
    cacheWrite =
      integer(usage.prompt_cache_creation_tokens) ??
      integer(at(usage, ['prompt_tokens_details', 'cache_creation_tokens']));
    output = integer(usage.completion_tokens);
    reasoning = integer(at(usage, ['completion_tokens_details', 'reasoning_tokens']));
    explicitTotal = integer(usage.total_tokens);
  } else if (kind === 'ollama') {
    input = integer(usage.prompt_eval_count);
    output = integer(usage.eval_count);
  } else {
    input = integer(usage.input_tokens);
    cacheRead = integer(usage.cache_read_input_tokens);
    cacheWrite = integer(usage.cache_creation_input_tokens);
    output = integer(usage.output_tokens);
  }
  const uncached =
    kind === 'anthropicMessages'
      ? input
      : (integer(usage.prompt_cache_miss_tokens) ??
        (input === undefined ? undefined : Math.max(0, input - (cacheRead || 0))));
  const total =
    explicitTotal ??
    (input !== undefined && output !== undefined
      ? kind === 'anthropicMessages'
        ? input + (cacheRead || 0) + (cacheWrite || 0) + output
        : input + output
      : undefined);
  const result: ModelUsage = {};
  if (uncached !== undefined) result.uncachedInputTokens = uncached;
  if (cacheRead !== undefined) result.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) result.cacheWriteTokens = cacheWrite;
  if (output !== undefined) result.outputTokens = output;
  if (reasoning !== undefined) result.reasoningTokens = reasoning;
  if (total !== undefined) result.totalTokens = total;
  return Object.keys(result).length ? result : undefined;
}

export function mergeUsage(target: ModelUsage, next: ModelUsage) {
  Object.assign(target, next);
  if (
    next.totalTokens === undefined &&
    target.uncachedInputTokens !== undefined &&
    target.outputTokens !== undefined
  )
    target.totalTokens =
      target.uncachedInputTokens + (target.cacheReadTokens || 0) + target.outputTokens;
  return target;
}

export function normalizeProviderError(status: number, message: string, retryAfterMs?: number) {
  const lower = message.toLowerCase();
  const context = [
    'context length',
    'context window',
    'maximum context',
    'too many tokens',
    'prompt is too long',
  ].some((phrase) => lower.includes(phrase));
  const kind: NormalizedErrorKind =
    status === 401 || status === 403
      ? 'authentication'
      : status === 429
        ? 'rateLimited'
        : context
          ? 'contextTooLarge'
          : status === 408 || status === 409 || status === 425 || status >= 500
            ? 'retryable'
            : 'terminal';
  return new NormalizedModelError(
    kind,
    message.trim()
      ? `AI provider returned HTTP ${status}: ${message}`
      : `AI provider returned HTTP ${status}`,
    status,
    `HTTP_${status}`,
    retryAfterMs,
  );
}

export function parseRetryAfter(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (/^\d+$/.test(value.trim()) && Number.isSafeInteger(seconds)) return seconds * 1000;
  const deadline = Date.parse(value.trim());
  return Number.isFinite(deadline) && deadline > now ? deadline - now : undefined;
}

export function retryPlan(
  policy: RetryPolicy,
  error: NormalizedModelError,
  failedAttempt: number,
  randomSample: number,
) {
  if (!error.retryable || failedAttempt >= Math.min(8, Math.max(1, policy.maxAttempts)))
    return undefined;
  if (error.retryAfterMs && error.retryAfterMs > 0) {
    const cap = Math.min(300_000, policy.maxServerDelayMs);
    return {
      delayMs: Math.min(error.retryAfterMs, cap),
      serverRetryAfterMs: error.retryAfterMs,
      serverHintCapped: error.retryAfterMs > cap,
    };
  }
  const cap = Math.min(300_000, policy.maxDelayMs);
  const exponential = Math.min(
    cap,
    Math.min(300_000, policy.initialDelayMs) * 2 ** Math.min(62, failedAttempt - 1),
  );
  const ratio = Math.max(0, Math.min(1, policy.jitterRatio));
  const sample = Math.max(0, Math.min(1, randomSample));
  return {
    delayMs: Math.min(cap, Math.round(exponential * (1 - ratio + 2 * ratio * sample))),
    serverRetryAfterMs: undefined,
    serverHintCapped: false,
  };
}

export type RequestSnapshot =
  | { status: 'legacyUnknown' }
  | {
      status: 'prepared';
      routeId: string;
      routeRevision: number;
      adapterId: ProviderRoute['adapterId'];
      modelId: string;
      catalogVersion: number;
      capabilities: Omit<
        ResolvedModel,
        | 'catalogVersion'
        | 'routeId'
        | 'providerId'
        | 'profile'
        | 'kind'
        | 'modelId'
        | 'source'
        | 'capacityPolicy'
      >;
      endpointIdentity: string;
      replayDomainId: string;
      reasoningEffort?: string;
      outputTokens: number;
      retryPolicy: RetryPolicy;
      timeouts: RouteTimeouts;
      purpose: string;
      preparationVersion: 1;
      projectionPolicy: 'immutable-png-v1-strict';
      contentHash: string;
      images: ImageReference[];
    };

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function persistedRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(persistedRequest);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['requestId', 'dataUrls', 'replay', 'nativeReplay'].includes(key))
      .map(([key, entry]) => [key, persistedRequest(entry)]),
  );
}

export function prepareRequestSnapshot(
  provider: ProviderConfig,
  route: ProviderRoute,
  request: unknown,
  purpose: string,
  images: ImageReference[] = [],
) {
  const resolved = resolveModel(provider);
  const {
    catalogVersion: _,
    routeId: _routeId,
    providerId: _providerId,
    profile: _profile,
    kind: _kind,
    modelId: _modelId,
    source: _source,
    capacityPolicy: _capacity,
    ...capabilities
  } = resolved;
  const snapshot: RequestSnapshot = {
    status: 'prepared',
    routeId: route.id,
    routeRevision: route.revision,
    adapterId: route.adapterId,
    modelId: provider.model,
    catalogVersion: resolved.catalogVersion,
    capabilities,
    endpointIdentity: endpointUrl(
      provider,
      provider.kind === 'openAi'
        ? 'responses'
        : provider.kind === 'openAiCompatible'
          ? 'chat/completions'
          : provider.kind === 'ollama'
            ? 'api/chat'
            : 'messages',
    ).toString(),
    replayDomainId: route.replayDomainId,
    ...(provider.reasoningEffort ? { reasoningEffort: provider.reasoningEffort } : {}),
    outputTokens: resolved.maxOutputTokens,
    retryPolicy: structuredClone(provider.retryPolicy || defaultRetryPolicy),
    timeouts: structuredClone(route.timeouts),
    purpose,
    preparationVersion: 1,
    projectionPolicy: 'immutable-png-v1-strict',
    contentHash: digest(persistedRequest(request)),
    images: structuredClone(images),
  };
  return { snapshot, digest: digest(snapshot) };
}

export function applyReasoning(body: Record<string, unknown>, provider: ProviderConfig) {
  const model = resolveModel(provider);
  const compat = model.compat;
  if (compat.defaultThinking)
    body.thinking = { type: 'enabled', clear_thinking: !compat.clearThinking };
  if (!provider.reasoningEffort) return body;
  const option = model.reasoning.find((item) => item.id === provider.reasoningEffort);
  const effort = option?.wireValue ?? provider.reasoningEffort;
  const enabled = effort !== 'off' && effort !== 'none';
  switch (compat.reasoningEncoding) {
    case 'responses':
      body.reasoning = { effort };
      break;
    case 'enableThinking':
      body.enable_thinking = enabled;
      break;
    case 'thinking':
    case 'adaptive':
    case 'thinkingEffort': {
      const thinking: Record<string, unknown> = {
        type: !enabled
          ? 'disabled'
          : compat.reasoningEncoding === 'adaptive'
            ? 'adaptive'
            : 'enabled',
      };
      if (compat.clearThinking) thinking.clear_thinking = false;
      body.thinking = thinking;
      if (enabled && compat.reasoningEncoding === 'thinkingEffort') body.reasoning_effort = effort;
      break;
    }
    case 'effort':
      body.reasoning_effort = effort;
      break;
    case 'anthropicAdaptive':
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort };
      break;
    case 'ollama':
      body.think = effort === 'off' || effort === 'on' ? enabled : effort;
      break;
  }
  return body;
}

export function prepareProviderBody(provider: ProviderConfig, input: unknown) {
  const body = structuredClone(input) as Record<string, unknown>;
  const resolved = resolveModel(provider);
  if (provider.kind === 'openAi') body.max_output_tokens = resolved.maxOutputTokens;
  else if (provider.kind === 'ollama') {
    const options =
      body.options && typeof body.options === 'object' && !Array.isArray(body.options)
        ? (body.options as Record<string, unknown>)
        : {};
    options.num_predict = resolved.maxOutputTokens;
    body.options = options;
  } else body.max_tokens = resolved.maxOutputTokens;
  return applyReasoning(body, provider);
}

type FinishReason = 'stop' | 'toolCalls' | 'length' | 'contentFilter' | 'other';
type Recording = {
  adapterId: 'responses' | 'chat-completions' | 'ollama' | 'anthropic-messages';
  framing: 'sse' | 'ndjson';
  frames: string[];
  cumulativeStream?: boolean;
};
type ParsedResponse = {
  content: ModelContentBlock[];
  finishReason: FinishReason;
  usage: ModelUsage;
  replay: { response: Record<string, unknown>; blocks: unknown[]; recording: Recording };
};

type AccumulatedBlock = {
  type: 'text' | 'reasoning' | 'toolCall';
  text: string;
  callId: string;
  name: string;
  arguments: string;
};

function finishReason(value: unknown): FinishReason {
  return value === 'stop' || value === 'end_turn'
    ? 'stop'
    : value === 'tool_calls' || value === 'tool_use'
      ? 'toolCalls'
      : value === 'length' || value === 'max_tokens'
        ? 'length'
        : value === 'content_filter'
          ? 'contentFilter'
          : 'other';
}

function parseJson(raw: string, label: string) {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new NormalizedModelError(
      'protocol',
      `invalid ${label} stream event: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      'INVALID_STREAM_EVENT',
    );
  }
}

class StreamAccumulator {
  readonly blocks = new Map<string, AccumulatedBlock>();
  readonly usage: ModelUsage = {};
  readonly response: Record<string, unknown> = {};
  completed = false;
  reason: FinishReason = 'other';
  private index(key: string, type: AccumulatedBlock['type']) {
    if (!this.blocks.has(key))
      this.blocks.set(key, { type, text: '', callId: '', name: '', arguments: '' });
    return [...this.blocks.keys()].indexOf(key);
  }
  text(key: string, type: 'text' | 'reasoning', text: string, emit: (delta: StreamDelta) => void) {
    if (!text) return;
    const index = this.index(key, type);
    this.blocks.get(key)!.text += text;
    emit({ type, index, text });
  }
  tool(
    key: string,
    callId: string | undefined,
    name: string | undefined,
    args: string | undefined,
    emit: (delta: StreamDelta) => void,
    cumulative = false,
  ) {
    const index = this.index(key, 'toolCall');
    const block = this.blocks.get(key)!;
    const fragment = (previous: string, next: string | undefined) => {
      if (!next || !cumulative) return next;
      return next.startsWith(previous)
        ? next.slice(previous.length)
        : previous.startsWith(next)
          ? ''
          : next;
    };
    const callIdDelta = fragment(block.callId, callId);
    const nameDelta = fragment(block.name, name);
    const argumentsDelta = fragment(block.arguments, args);
    if (callIdDelta) block.callId += callIdDelta;
    if (nameDelta) block.name += nameDelta;
    if (argumentsDelta) block.arguments += argumentsDelta;
    if (callIdDelta || nameDelta || argumentsDelta)
      emit({
        type: 'toolCall',
        index,
        callId: callIdDelta,
        nameDelta,
        argumentsDelta,
      });
  }
  addUsage(kind: ProviderKind, value: unknown, emit: (delta: StreamDelta) => void) {
    const usage = providerUsageFromValue(kind, value);
    if (!usage) return;
    mergeUsage(this.usage, usage);
    emit({ type: 'usage', usage });
  }
  result(recording: Recording): ParsedResponse {
    const content: ModelContentBlock[] = [];
    for (const block of this.blocks.values()) {
      if (block.type === 'text' || block.type === 'reasoning') {
        if (block.text) content.push({ type: block.type, text: block.text });
      } else if (block.name || block.arguments || block.callId) {
        let args: unknown = {};
        try {
          args = block.arguments ? JSON.parse(block.arguments) : {};
        } catch {
          throw new NormalizedModelError(
            'protocol',
            'tool call arguments are not valid JSON',
            undefined,
            'TOOL_ARGUMENTS',
          );
        }
        content.push({
          type: 'toolCall',
          call: {
            callId: block.callId || `call-${content.length + 1}`,
            ...(block.callId ? { providerCallId: block.callId } : {}),
            name: block.name,
            arguments: args,
          },
        });
      }
    }
    if (!content.length)
      throw new NormalizedModelError(
        'emptyResponse',
        'AI provider returned no usable content',
        undefined,
        'EMPTY_RESPONSE',
      );
    if (content.some((block) => block.type === 'toolCall')) this.reason = 'toolCalls';
    return {
      content,
      finishReason: this.reason,
      usage: this.usage,
      replay: {
        response: this.response,
        blocks: content.map((block) =>
          block.type === 'toolCall' && block.call.providerCallId
            ? { providerCallId: block.call.providerCallId }
            : {},
        ),
        recording,
      },
    };
  }
}

function processChat(
  value: Record<string, unknown>,
  state: StreamAccumulator,
  emit: (delta: StreamDelta) => void,
  cumulative = false,
) {
  for (const [source, target] of [
    ['id', 'id'],
    ['model', 'model'],
    ['system_fingerprint', 'systemFingerprint'],
  ])
    if (typeof value[source] === 'string') state.response[target] = value[source];
  state.addUsage('openAiCompatible', value, emit);
  const message = at(value, ['error', 'message']) || value.message;
  if (typeof message === 'string') throw normalizeProviderError(400, message);
  const reason = at(value, ['choices', '0', 'finish_reason']);
  if (typeof reason === 'string') {
    state.completed = true;
    state.reason = finishReason(reason);
  }
  const delta = (at(value, ['choices', '0', 'delta']) || {}) as Record<string, unknown>;
  const append = (key: string, next: string) => {
    if (!cumulative) return next;
    const previous = state.blocks.get(key)?.text || '';
    return next.startsWith(previous)
      ? next.slice(previous.length)
      : previous.startsWith(next)
        ? ''
        : next;
  };
  const reasoning = delta.reasoning_content || delta.reasoning;
  if (typeof reasoning === 'string')
    state.text('reasoning', 'reasoning', append('reasoning', reasoning), emit);
  if (typeof delta.content === 'string')
    state.text('text', 'text', append('text', delta.content), emit);
  const calls = delta.tool_calls;
  if (Array.isArray(calls))
    for (const [position, item] of calls.entries()) {
      const call = item as Record<string, unknown>;
      const ordinal = integer(call.index) ?? position;
      const fn = (call.function || {}) as Record<string, unknown>;
      state.tool(
        `tool:${ordinal}`,
        typeof call.id === 'string' ? call.id : undefined,
        typeof fn.name === 'string' ? fn.name : undefined,
        typeof fn.arguments === 'string' ? fn.arguments : undefined,
        emit,
        cumulative,
      );
    }
}

function processOllama(
  value: Record<string, unknown>,
  state: StreamAccumulator,
  emit: (delta: StreamDelta) => void,
) {
  for (const [source, target] of [
    ['model', 'model'],
    ['created_at', 'createdAt'],
    ['done_reason', 'doneReason'],
  ])
    if (typeof value[source] === 'string') state.response[target] = value[source];
  state.addUsage('ollama', value, emit);
  if (typeof value.error === 'string') throw normalizeProviderError(400, value.error);
  if (value.done_reason === 'length')
    throw new NormalizedModelError(
      'terminal',
      'AI provider reached the configured output token limit',
    );
  if (value.done === true) {
    state.completed = true;
    state.reason = finishReason(value.done_reason || 'stop');
  }
  const message = (value.message || {}) as Record<string, unknown>;
  const reasoning = message.thinking || message.reasoning_content;
  if (typeof reasoning === 'string') state.text('reasoning', 'reasoning', reasoning, emit);
  if (typeof message.content === 'string') state.text('text', 'text', message.content, emit);
  if (Array.isArray(message.tool_calls))
    for (const [index, item] of message.tool_calls.entries()) {
      const call = item as Record<string, unknown>;
      const fn = (call.function || {}) as Record<string, unknown>;
      state.tool(
        `tool:${index}`,
        typeof call.id === 'string' ? call.id : undefined,
        typeof fn.name === 'string' ? fn.name : undefined,
        typeof fn.arguments === 'string'
          ? fn.arguments
          : fn.arguments === undefined
            ? undefined
            : JSON.stringify(fn.arguments),
        emit,
        true,
      );
    }
}

function processResponses(
  value: Record<string, unknown>,
  state: StreamAccumulator,
  emit: (delta: StreamDelta) => void,
) {
  state.addUsage('openAi', value, emit);
  const type = value.type;
  const index = integer(value.output_index) ?? integer(value.item_index) ?? 0;
  if (type === 'response.output_text.delta' || type === 'response.refusal.delta')
    state.text(`text:${index}`, 'text', String(value.delta || ''), emit);
  else if (
    type === 'response.reasoning_text.delta' ||
    type === 'response.reasoning_summary_text.delta'
  )
    state.text(`reasoning:${index}`, 'reasoning', String(value.delta || ''), emit);
  else if (type === 'response.function_call_arguments.delta')
    state.tool(
      `tool:${index}`,
      undefined,
      typeof value.name === 'string' ? value.name : undefined,
      typeof value.delta === 'string' ? value.delta : undefined,
      emit,
    );
  else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = value.item as Record<string, unknown> | undefined;
    if (item?.type === 'function_call')
      state.tool(
        `tool:${index}`,
        typeof item.call_id === 'string' ? item.call_id : undefined,
        typeof item.name === 'string' ? item.name : undefined,
        typeof item.arguments === 'string' ? item.arguments : undefined,
        emit,
        true,
      );
  } else if (type === 'response.completed') {
    state.completed = true;
    state.reason = 'stop';
    const response = value.response as Record<string, unknown> | undefined;
    if (typeof response?.id === 'string') state.response.id = response.id;
    if (typeof response?.model === 'string') state.response.model = response.model;
  } else if (type === 'response.incomplete') {
    throw new NormalizedModelError(
      'terminal',
      'AI provider reached the configured output token limit',
    );
  } else if (type === 'response.failed' || type === 'error') {
    const message =
      at(value, ['response', 'error', 'message']) ||
      at(value, ['error', 'message']) ||
      'OpenAI response failed';
    throw normalizeProviderError(400, String(message));
  }
}

function processAnthropic(
  value: Record<string, unknown>,
  state: StreamAccumulator,
  emit: (delta: StreamDelta) => void,
) {
  const type = value.type;
  if (type === 'message_start') {
    const message = value.message as Record<string, unknown> | undefined;
    if (typeof message?.id === 'string') state.response.id = message.id;
    if (typeof message?.model === 'string') state.response.model = message.model;
    if (message) state.addUsage('anthropicMessages', message, emit);
  } else if (type === 'content_block_start') {
    const index = integer(value.index) ?? 0;
    const block = value.content_block as Record<string, unknown> | undefined;
    if (block?.type === 'text')
      state.text(`block:${index}`, 'text', String(block.text || ''), emit);
    else if (block?.type === 'thinking')
      state.text(`block:${index}`, 'reasoning', String(block.thinking || ''), emit);
    else if (block?.type === 'tool_use')
      state.tool(
        `block:${index}`,
        typeof block.id === 'string' ? block.id : undefined,
        typeof block.name === 'string' ? block.name : undefined,
        block.input && Object.keys(block.input as object).length
          ? JSON.stringify(block.input)
          : undefined,
        emit,
        true,
      );
  } else if (type === 'content_block_delta') {
    const index = integer(value.index) ?? 0;
    const delta = (value.delta || {}) as Record<string, unknown>;
    if (typeof delta.text === 'string') state.text(`block:${index}`, 'text', delta.text, emit);
    else if (typeof delta.thinking === 'string')
      state.text(`block:${index}`, 'reasoning', delta.thinking, emit);
    else if (typeof delta.partial_json === 'string')
      state.tool(`block:${index}`, undefined, undefined, delta.partial_json, emit);
  } else if (type === 'message_delta') {
    state.addUsage('anthropicMessages', value, emit);
    const reason = at(value, ['delta', 'stop_reason']);
    if (typeof reason === 'string') {
      state.reason = finishReason(reason);
      state.completed = true;
    }
  } else if (type === 'error') {
    throw normalizeProviderError(
      400,
      String(at(value, ['error', 'message']) || 'Anthropic response failed'),
    );
  }
}

export class ProviderStreamParser {
  private readonly state = new StreamAccumulator();

  constructor(
    private readonly adapterId: Recording['adapterId'],
    private readonly emit: (delta: StreamDelta) => void = () => {},
    private readonly cumulativeStream = false,
  ) {}

  push(raw: string) {
    if (raw === '[DONE]') {
      this.state.completed = true;
      return;
    }
    const value = parseJson(raw, this.adapterId);
    if (this.adapterId === 'chat-completions')
      processChat(value, this.state, this.emit, this.cumulativeStream);
    else if (this.adapterId === 'responses') processResponses(value, this.state, this.emit);
    else if (this.adapterId === 'ollama') processOllama(value, this.state, this.emit);
    else processAnthropic(value, this.state, this.emit);
  }

  finish(recording: Recording) {
    if (!this.state.completed)
      throw new NormalizedModelError(
        'retryable',
        `${recording.adapterId} stream ended before completion`,
        undefined,
        'STREAM_CLOSED',
      );
    return this.state.result(recording);
  }
}

export function replayProviderRecording(
  recording: Recording,
  emit: (delta: StreamDelta) => void = () => {},
) {
  const parser = new ProviderStreamParser(recording.adapterId, emit, recording.cumulativeStream);
  for (const raw of recording.frames) parser.push(raw);
  return parser.finish(recording);
}

function combineSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => !parent?.aborted && controller.signal.aborted,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

async function boundedText(response: Response, maxBytes: number, limitMessage: string) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(limitMessage);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) throw new Error(limitMessage);
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function requestFrames(
  response: Response,
  framing: Recording['framing'],
  timeouts: RouteTimeouts,
  signal?: AbortSignal,
  onFrame: (frame: string) => void = () => {},
) {
  if (!response.body)
    throw new NormalizedModelError(
      'emptyResponse',
      'AI provider returned an empty response body',
      undefined,
      'EMPTY_RESPONSE',
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  let seenBytes = false;
  const frames: string[] = [];
  const appendFrame = (frame: string) => {
    frames.push(frame);
    onFrame(frame);
  };
  try {
    for (;;) {
      if (signal?.aborted) throw NormalizedModelError.cancelled();
      const timeout = combineSignal(
        signal,
        seenBytes ? timeouts.streamIdleMs : timeouts.firstByteMs,
      );
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            timeout.signal.addEventListener(
              'abort',
              () =>
                reject(
                  signal?.aborted
                    ? NormalizedModelError.cancelled()
                    : new NormalizedModelError(
                        'timeout',
                        seenBytes
                          ? `AI provider stream was idle for ${timeouts.streamIdleMs} ms`
                          : `AI provider returned no stream bytes within ${timeouts.firstByteMs} ms`,
                        undefined,
                        seenBytes ? 'STREAM_IDLE_TIMEOUT' : 'FIRST_BYTE_TIMEOUT',
                      ),
                ),
              { once: true },
            ),
          ),
        ]);
      } finally {
        timeout.dispose();
      }
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_STREAM_BYTES)
        throw new NormalizedModelError(
          'protocol',
          'AI provider stream exceeded the 16 MiB response limit',
          undefined,
          'STREAM_LIMIT',
        );
      seenBytes ||= result.value.byteLength > 0;
      buffer += decoder.decode(result.value, { stream: true });
      for (;;) {
        const match = framing === 'sse' ? buffer.match(/\r?\n\r?\n/) : buffer.match(/\r?\n/);
        if (!match?.index && match?.index !== 0) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
          throw new NormalizedModelError(
            'protocol',
            'AI provider stream event exceeded the 1 MiB framing limit',
            undefined,
            'STREAM_LIMIT',
          );
        if (framing === 'sse') {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) appendFrame(data);
        } else if (frame.trim()) appendFrame(frame.trim());
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
        throw new NormalizedModelError(
          'protocol',
          'AI provider stream event exceeded the 1 MiB framing limit',
          undefined,
          'STREAM_LIMIT',
        );
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      if (framing === 'sse') {
        const data = buffer
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) appendFrame(data);
      } else appendFrame(buffer.trim());
    }
    if (!seenBytes)
      throw new NormalizedModelError(
        'emptyResponse',
        'AI provider stream returned an empty response body',
        undefined,
        'EMPTY_RESPONSE',
      );
    return frames;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function adapterFor(kind: ProviderKind): Recording['adapterId'] {
  return kind === 'openAi'
    ? 'responses'
    : kind === 'openAiCompatible'
      ? 'chat-completions'
      : kind === 'ollama'
        ? 'ollama'
        : 'anthropic-messages';
}

export type StreamProviderOptions = {
  provider: ProviderConfig;
  apiKey?: string;
  body: unknown;
  signal?: AbortSignal;
  timeouts?: RouteTimeouts;
  retryPolicy?: RetryPolicy;
  random?: () => number;
  emit?: (delta: StreamDelta) => void;
};

export async function streamProvider(options: StreamProviderOptions) {
  validateProviderConfig(options.provider, true);
  resolveModel(options.provider);
  const timeouts = options.timeouts || {
    requestHeadersMs: 30_000,
    firstByteMs: 30_000,
    streamIdleMs: 300_000,
  };
  const policy = options.retryPolicy || options.provider.retryPolicy || defaultRetryPolicy;
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw NormalizedModelError.cancelled();
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': `ShellSpan/${process.env.SHELLSPAN_APP_VERSION || '0.0.0'}`,
      };
      if (options.provider.kind === 'anthropicMessages') {
        if (!options.apiKey?.trim())
          throw new NormalizedModelError('authentication', 'MISSING_CREDENTIAL');
        headers['x-api-key'] = options.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else if (options.apiKey?.trim()) headers.authorization = `Bearer ${options.apiKey}`;
      const endpoint = endpointUrl(
        options.provider,
        options.provider.kind === 'openAi'
          ? 'responses'
          : options.provider.kind === 'openAiCompatible'
            ? 'chat/completions'
            : options.provider.kind === 'ollama'
              ? 'api/chat'
              : 'messages',
      );
      const timeout = combineSignal(options.signal, timeouts.requestHeadersMs);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(prepareProviderBody(options.provider, options.body)),
          signal: timeout.signal,
          redirect: 'manual',
        });
      } catch (error) {
        if (options.signal?.aborted) throw NormalizedModelError.cancelled();
        if (timeout.timedOut())
          throw new NormalizedModelError(
            'timeout',
            'AI provider timed out before returning response headers',
            undefined,
            'REQUEST_HEADERS_TIMEOUT',
          );
        throw new NormalizedModelError(
          'transport',
          `AI provider request failed: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          'CONNECT',
        );
      } finally {
        timeout.dispose();
      }
      if (!response.ok) {
        const retryAfterMsHeader = response.headers.get('retry-after-ms');
        const retryAfter =
          parseRetryAfter(response.headers.get('retry-after')) ??
          (retryAfterMsHeader === null ? undefined : integer(Number(retryAfterMsHeader)));
        let body: string;
        try {
          body = await boundedText(
            response,
            MAX_ERROR_BYTES,
            'AI provider HTTP error body exceeded the 4 KiB response limit',
          );
        } catch (error) {
          throw new NormalizedModelError(
            'terminal',
            error instanceof Error ? error.message : String(error),
          );
        }
        throw normalizeProviderError(response.status, body, retryAfter);
      }
      const adapterId = adapterFor(options.provider.kind);
      const framing = options.provider.kind === 'ollama' ? 'ndjson' : 'sse';
      const parser = new ProviderStreamParser(
        adapterId,
        options.emit,
        resolveModel(options.provider).compat.cumulativeStream,
      );
      const frames = await requestFrames(response, framing, timeouts, options.signal, (frame) =>
        parser.push(frame),
      );
      return parser.finish({ adapterId, framing, frames });
    } catch (error) {
      const normalized =
        error instanceof NormalizedModelError
          ? error
          : new NormalizedModelError(
              'terminal',
              error instanceof Error ? error.message : String(error),
            );
      const plan = retryPlan(policy, normalized, attempt, (options.random || Math.random)());
      if (!plan) throw normalized;
      try {
        await delay(plan.delayMs, undefined, { signal: options.signal });
      } catch {
        throw NormalizedModelError.cancelled();
      }
    }
  }
}

export async function listProviderModels(
  provider: ProviderConfig,
  apiKey?: string,
  signal?: AbortSignal,
) {
  validateProviderConfig(provider, false);
  if (provider.kind === 'anthropicMessages' && !apiKey?.trim())
    throw new Error('MISSING_CREDENTIAL');
  const headers: Record<string, string> = {
    'user-agent': `ShellSpan/${process.env.SHELLSPAN_APP_VERSION || '0.0.0'}`,
  };
  if (provider.kind === 'anthropicMessages') {
    headers['x-api-key'] = apiKey!;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey?.trim()) headers.authorization = `Bearer ${apiKey}`;
  const endpoint = endpointUrl(provider, provider.kind === 'ollama' ? 'api/tags' : 'models');
  let response: Response;
  try {
    response = await fetch(endpoint, { headers, signal, redirect: 'manual' });
  } catch (error) {
    if (signal?.aborted) throw new Error('model request cancelled');
    throw new Error(
      `AI provider request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const body = await boundedText(
      response,
      MAX_ERROR_BYTES,
      'AI provider HTTP error body exceeded the 4 KiB response limit',
    );
    throw new Error(normalizeProviderError(response.status, body).message);
  }
  const raw = await boundedText(
    response,
    MAX_NON_STREAM_BYTES,
    'AI provider response exceeded the 1 MiB non-streaming limit',
  );
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `invalid AI provider response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const items = provider.kind === 'ollama' ? value.models : value.data;
  const models = Array.isArray(items)
    ? items
        .map((item) =>
          item && typeof item === 'object'
            ? provider.kind === 'ollama'
              ? (item as Record<string, unknown>).name
              : (item as Record<string, unknown>).id
            : undefined,
        )
        .filter((model): model is string => typeof model === 'string')
    : [];
  return [...new Set(models)].sort();
}

export type { Recording as ProviderRecording, ParsedResponse as ModelResponse };
