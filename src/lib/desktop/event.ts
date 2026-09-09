import type { DesktopEvent } from './contract';
import { desktop } from './core';

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}
export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;
let nextId = 0;
export async function listen<T>(
  event: DesktopEvent,
  callback: EventCallback<T>,
): Promise<UnlistenFn> {
  const id = ++nextId;
  return desktop().on(event, (payload) => callback({ event, id, payload: payload as T }));
}
