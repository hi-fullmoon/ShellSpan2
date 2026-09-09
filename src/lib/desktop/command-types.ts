import type { CommandArgs, CommandValues } from './generated-contract-types';

export type { CommandArgs, CommandValues } from './generated-contract-types';

export type CommandInput<C extends keyof CommandArgs> = {} extends CommandArgs[C]
  ? [args?: CommandArgs[C]]
  : [args: CommandArgs[C]];
export type WireValue<T> = [T] extends [void] ? null : T;
