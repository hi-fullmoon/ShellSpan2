import { desktop } from './core';

export const getVersion = (): Promise<string> => desktop().version();
