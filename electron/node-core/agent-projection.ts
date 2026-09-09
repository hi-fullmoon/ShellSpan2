import type {
  AgentEvent,
  AgentMessage,
  AgentRecoveryCheckpoint,
  AgentSessionRecord,
  AgentSnapshot,
  AgentStatus,
} from './agent-types.ts';

function eventData<T extends Record<string, unknown>>(event: AgentEvent) {
  return (event.data || {}) as T;
}

function removeMessages(queue: AgentMessage[], messages: AgentMessage[]) {
  const ids = new Set(messages.map((message) => message.messageId));
  return queue.filter((message) => !ids.has(message.messageId));
}

function projectInbox(events: AgentEvent[]) {
  let nextTurn: AgentMessage[] = [];
  let nextStep: AgentMessage[] = [];
  const paused = new Set<string>();
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      const data = eventData<{
        lane: 'nextTurn' | 'nextStep';
        operation: string;
        messages: AgentMessage[];
      }>(event);
      const queue = data.lane === 'nextTurn' ? nextTurn : nextStep;
      const replacement =
        data.operation === 'enqueued'
          ? [...queue, ...data.messages]
          : removeMessages(queue, data.messages);
      if (data.lane === 'nextTurn') nextTurn = replacement;
      else nextStep = replacement;
      if (data.operation !== 'enqueued')
        for (const message of data.messages) paused.delete(message.messageId);
    } else if (event.type === 'agent/inbox/paused') {
      for (const id of eventData<{ itemIds: string[] }>(event).itemIds) paused.add(id);
    } else if (event.type === 'agent/inbox/item_resumed') {
      paused.delete(eventData<{ itemId: string }>(event).itemId);
    } else if (event.type === 'agent/inbox/item_updated') {
      const data = eventData<{ itemId: string; lane: 'nextTurn' | 'nextStep'; content: string }>(
        event,
      );
      const queue = data.lane === 'nextTurn' ? nextTurn : nextStep;
      const message = queue.find((item) => item.messageId === data.itemId);
      if (message) message.content = data.content;
    } else if (event.type === 'agent/inbox/item_removed') {
      const data = eventData<{ itemId: string; lane: 'nextTurn' | 'nextStep' }>(event);
      if (data.lane === 'nextTurn')
        nextTurn = nextTurn.filter((item) => item.messageId !== data.itemId);
      else nextStep = nextStep.filter((item) => item.messageId !== data.itemId);
      paused.delete(data.itemId);
    } else if (event.type === 'agent/inbox/item_steered') {
      const id = eventData<{ itemId: string }>(event).itemId;
      const index = nextTurn.findIndex((item) => item.messageId === id);
      if (index >= 0) nextStep.push(...nextTurn.splice(index, 1));
    } else if (event.type === 'agent/inbox/reordered') {
      const data = eventData<{ lane: 'nextTurn' | 'nextStep'; orderedItemIds: string[] }>(event);
      const queue = data.lane === 'nextTurn' ? nextTurn : nextStep;
      const byId = new Map(queue.map((message) => [message.messageId, message]));
      const ordered = data.orderedItemIds
        .map((id) => byId.get(id))
        .filter((item): item is AgentMessage => Boolean(item));
      if (data.lane === 'nextTurn') nextTurn = ordered;
      else nextStep = ordered;
    }
  }
  return { pausedIds: [...paused], nextTurn, nextStep };
}

function projectSurface(events: AgentEvent[]) {
  let generation = 0;
  let replacedThroughSeq: number | undefined;
  let summary: Record<string, unknown> | undefined;
  const messages: Array<{ seq: number; value: Record<string, unknown> }> = [];
  for (const event of events) {
    if (event.type === 'user/message') {
      const message = eventData<{ message: AgentMessage }>(event).message;
      messages.push({
        seq: event.seq,
        value: message.images?.length
          ? {
              role: 'userImages',
              messageId: message.messageId,
              content: message.content,
              source: message.source,
              images: message.images,
            }
          : {
              role: 'user',
              messageId: message.messageId,
              content: message.content,
              source: message.source,
            },
      });
    } else if (event.type === 'assistant/message') {
      const data = eventData<Record<string, unknown>>(event);
      messages.push({
        seq: event.seq,
        value: {
          role: 'assistant',
          messageId: data.messageId,
          content: data.content,
          interrupted: data.interrupted,
        },
      });
    } else if (event.type === 'tool/result') {
      const data = eventData<Record<string, unknown>>(event);
      messages.push({
        seq: event.seq,
        value: {
          role: 'tool',
          callId: data.callId,
          name: data.name,
          status: data.status,
          content: JSON.stringify({ status: data.status, summary: data.summary, data: data.data }),
        },
      });
    } else if (event.type === 'compaction/summary') {
      const data = eventData<{
        surfaceGeneration: number;
        replacedThroughSeq: number;
        summary: string;
      }>(event);
      generation = data.surfaceGeneration;
      replacedThroughSeq = data.replacedThroughSeq;
      summary = {
        role: 'user',
        messageId: `compaction-${generation}`,
        content: data.summary,
        source: { kind: 'runtime', label: 'Compaction summary', producerId: 'shellspan-runtime' },
      };
    }
  }
  const retained = messages
    .filter((item) => replacedThroughSeq === undefined || item.seq > replacedThroughSeq)
    .map((item) => item.value);
  return {
    generation,
    ...(replacedThroughSeq === undefined ? {} : { replacedThroughSeq }),
    messages: summary ? [summary, ...retained] : retained,
  };
}

function projectRecovery(events: AgentEvent[]): AgentRecoveryCheckpoint {
  let recovery: AgentRecoveryCheckpoint = {
    status: 'none',
    kind: 'idle',
    lastCommittedSeq: Math.max(0, events.length - 1),
    summary: 'No recovery action is pending.',
  };
  const completed = new Set<string>();
  for (const event of events)
    if (event.type === 'tool/result')
      completed.add(String(eventData<{ callId: string }>(event).callId));
  for (const event of events) {
    if (event.type !== 'tool/execution') continue;
    const data = eventData<{ callId: string; idempotency: 'yes' | 'no' | 'conditional' }>(event);
    if (!completed.has(data.callId))
      recovery = {
        status: data.idempotency === 'yes' ? 'available' : 'required',
        kind: 'executionInFlight',
        lastCommittedSeq: event.seq,
        summary:
          data.idempotency === 'yes'
            ? 'An idempotent tool execution can be resumed'
            : 'A tool side effect requires reconciliation',
        turnId: event.turnId,
        stepId: event.stepId,
        callId: data.callId,
        idempotency: data.idempotency,
      };
  }
  const state = [...events].reverse().find((event) => event.type === 'task/state');
  const projected = state
    ? eventData<{ recovery?: { status?: AgentRecoveryCheckpoint['status']; summary?: string } }>(
        state,
      ).recovery
    : undefined;
  if (projected?.status)
    recovery = {
      ...recovery,
      status: projected.status,
      summary: projected.summary || recovery.summary,
    };
  if (events.some((event) => event.type === 'session/ended'))
    recovery = {
      status: 'none',
      kind: 'terminal',
      lastCommittedSeq: Math.max(0, events.length - 1),
      summary: 'Session reached a durable terminal event.',
    };
  return recovery;
}

export function projectAgentRecord(record: AgentSessionRecord): AgentSnapshot {
  const created = record.events.find((event) => event.type === 'session/created');
  if (!created) throw new Error('Agent Session log is missing session/created');
  const create = eventData<Record<string, unknown>>(created);
  const header: Record<string, unknown> = {
    sessionId: created.sessionId,
    createdAtUnixMs: created.timeUnixMs,
    ...structuredClone(create),
  };
  let status: AgentStatus = 'idle';
  let ended = false;
  const task: Record<string, unknown> & { evidence: Record<string, unknown>[] } = {
    taskId: create.taskId,
    goal: create.goal,
    evidence: [],
  };
  for (const event of record.events) {
    const data = eventData<Record<string, unknown>>(event);
    if (event.type === 'agent/status') status = data.status as AgentStatus;
    else if (event.type === 'session/ended') {
      status = data.status as AgentStatus;
      ended = true;
    } else if (event.type === 'session/resumed') {
      status = 'idle';
      ended = false;
    } else if (event.type === 'session/model_selected') header.modelSelection = data.provider;
    else if (event.type === 'session/permission_changed') header.permissionMode = data.mode;
    else if (event.type === 'session/renamed') header.title = data.title;
    else if (event.type === 'task/plan') task.plan = data;
    else if (event.type === 'task/state') Object.assign(task, data);
    else if (event.type === 'task/evidence')
      task.evidence.push({ ...data, recordedAtSeq: event.seq });
  }
  return {
    header,
    status,
    ended,
    archived: record.archived,
    eventCount: record.events.length,
    surface: projectSurface(record.events),
    inbox: projectInbox(record.events),
    task,
    recovery: projectRecovery(record.events),
  };
}
