import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function portablePath(value: string) {
  return value.replaceAll('\\', '/');
}

export function expandHomePath(value: string, home = homedir()) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(home, value.slice(2));
  return value;
}

export class NodeCorePaths {
  readonly appData: string;
  readonly logs: string;
  readonly home: string;
  readonly data: string;
  readonly database: string;

  constructor(env: NodeJS.ProcessEnv) {
    this.home = env.SHELLSPAN_HOME || homedir();
    const production = env.SHELLSPAN_BUILD_MODE === 'production';
    this.data = resolve(this.home, production ? '.shellspan' : '.shellspan-dev');
    this.database = resolve(this.data, 'shellspan.db');
    this.appData = env.SHELLSPAN_APP_DATA || resolve(this.home, '.shellspan');
    this.logs = env.SHELLSPAN_LOG_DIR || resolve(this.appData, 'logs');
  }
}
