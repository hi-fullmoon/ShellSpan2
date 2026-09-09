import type { Socket } from 'node:net';
import { redactDiagnostic } from './redaction.ts';

type SendFrame = (value: unknown) => Promise<void>;

const terminalEvents = new Set(['ssh-status', 'ssh-closed', 'ssh-session-error']);

/** Keeps control events and sequenced terminal events on their protocol-v1 channels. */
export class NodeCoreEventSender {
  private terminalSequence = 0;

  constructor(
    private readonly sendControl: SendFrame,
    private readonly sendTerminal: SendFrame,
    readonly terminalSocket: Socket,
  ) {}

  emit(event: string, payload: unknown) {
    if (event.startsWith('ssh-data:') || terminalEvents.has(event))
      return this.sendTerminal({
        type: 'event',
        event,
        payload,
        terminalSeq: ++this.terminalSequence,
      });
    return this.sendControl({ type: 'event', event, payload });
  }

  log(level: string, message: string, target = 'node-core') {
    return this.sendControl({ type: 'log', level, message: redactDiagnostic(message), target });
  }
}
