import { desktop } from './core';

export const debug = (message: string): Promise<void> => desktop().log('debug', message);
export const info = (message: string): Promise<void> => desktop().log('info', message);
export const warn = (message: string): Promise<void> => desktop().log('warn', message);
export const error = (message: string): Promise<void> => desktop().log('error', message);
