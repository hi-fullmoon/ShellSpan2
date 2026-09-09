import type { DesktopEvent } from './contract';
import type { DesktopEventPayloads } from './generated-contract-types';

export type { DesktopEventPayloads } from './generated-contract-types';
export type DesktopPayload<E extends DesktopEvent> = E extends `ssh-data:${string}`
  ? string
  : E extends keyof DesktopEventPayloads
    ? DesktopEventPayloads[E]
    : never;
