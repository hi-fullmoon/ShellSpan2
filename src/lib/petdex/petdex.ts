import { invoke } from '@/lib/desktop/core';
import { listen, type UnlistenFn } from '@/lib/desktop/event';
import type { PetdexConnectionStatus } from '@/types';

const PETDEX_STATUS_EVENT = 'petdex-status';
const PETDEX_CONNECTION_STATUSES: readonly PetdexConnectionStatus[] = [
  'notDetected',
  'connected',
  'notRunning',
  'connectionError',
];

export function isPetdexConnectionStatus(value: unknown): value is PetdexConnectionStatus {
  return (
    typeof value === 'string' &&
    PETDEX_CONNECTION_STATUSES.includes(value as PetdexConnectionStatus)
  );
}

function normalizeStatus(value: unknown): PetdexConnectionStatus {
  return isPetdexConnectionStatus(value) ? value : 'connectionError';
}

export async function configurePetdex(enabled: boolean): Promise<PetdexConnectionStatus> {
  return normalizeStatus(await invoke<unknown>('petdex_set_enabled', { enabled }));
}

export async function getPetdexStatus(): Promise<PetdexConnectionStatus> {
  return normalizeStatus(await invoke<unknown>('petdex_get_status'));
}

export async function testPetdexConnection(): Promise<PetdexConnectionStatus> {
  return normalizeStatus(await invoke<unknown>('petdex_test_connection'));
}

export function listenToPetdexStatus(
  callback: (status: PetdexConnectionStatus) => void,
): Promise<UnlistenFn> {
  return listen<unknown>(PETDEX_STATUS_EVENT, (event) => {
    callback(normalizeStatus(event.payload));
  });
}
