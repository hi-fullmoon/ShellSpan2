export type AgentStatus = 'idle' | 'running' | 'waiting' | 'cancelled' | 'completed' | 'failed';
export type AgentLane = 'nextTurn' | 'nextStep';

export type AgentMessage = {
  messageId: string;
  clientSubmissionId?: string;
  content: string;
  images?: AgentImageReference[];
  source: {
    kind:
      | 'user'
      | 'runtime'
      | 'plugin'
      | 'skill-catalog'
      | 'agent-instructions'
      | 'skill-invocation'
      | 'session-reference'
      | 'form';
    label: string;
    producerId: string;
    metadata?: Record<string, unknown>;
  };
};

export type AgentImageReference = {
  version: 1;
  sha256: string;
  mediaType: 'image/png';
  bytes: number;
  width: number;
  height: number;
  name: string;
};

export type AgentEvent = {
  version: 5;
  sessionId: string;
  seq: number;
  timeUnixMs: number;
  turnId?: string;
  stepId?: string;
  type: string;
  data?: Record<string, unknown>;
};

export type AgentSessionRecord = {
  events: AgentEvent[];
  archived: boolean;
  path: string;
};

export type AgentRecoveryCheckpoint = {
  status: 'none' | 'available' | 'required' | 'reconciling' | 'completed';
  kind:
    | 'idle'
    | 'openModelRequest'
    | 'waitingApproval'
    | 'authorizedBeforeExecute'
    | 'executionInFlight'
    | 'toolResultCommitted'
    | 'compactionInFlight'
    | 'artifactIntegrity'
    | 'cancelled'
    | 'terminal';
  lastCommittedSeq: number;
  summary: string;
  turnId?: string;
  stepId?: string;
  requestId?: string;
  callId?: string;
  effect?: string;
  idempotency?: 'yes' | 'no' | 'conditional';
};

export type AgentSnapshot = {
  header: Record<string, unknown>;
  status: AgentStatus;
  ended: boolean;
  archived: boolean;
  eventCount: number;
  surface: {
    generation: number;
    replacedThroughSeq?: number;
    messages: Record<string, unknown>[];
  };
  inbox: { pausedIds?: string[]; nextTurn: AgentMessage[]; nextStep: AgentMessage[] };
  task: Record<string, unknown> & { evidence: Record<string, unknown>[] };
  recovery: AgentRecoveryCheckpoint;
};

export function userMessage(
  messageId: string,
  content: string,
  clientSubmissionId?: string,
  images?: AgentImageReference[],
): AgentMessage {
  return {
    messageId,
    ...(clientSubmissionId ? { clientSubmissionId } : {}),
    content,
    ...(images?.length ? { images } : {}),
    source: { kind: 'user', label: 'User', producerId: 'shellspan-user' },
  };
}
