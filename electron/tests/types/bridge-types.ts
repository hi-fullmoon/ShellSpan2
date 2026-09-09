import type { DesktopBridge } from '../../../src/lib/desktop/core';
import type { CommandArgs, CommandValues } from '../../../src/lib/desktop/command-types';
import type { DesktopCommand } from '../../../src/lib/desktop/contract';

type Assert<T extends true> = T;
type SameKeys = Assert<
  [DesktopCommand, keyof CommandArgs, keyof CommandValues] extends [
    keyof CommandArgs,
    keyof CommandValues,
    DesktopCommand,
  ]
    ? true
    : false
>;
export function typeOnly(bridge: DesktopBridge): SameKeys {
  bridge.commands.resize_session({ sessionId: 's', cols: 80, rows: 24 });
  bridge.commands.pick_local_folder({ title: null });
  bridge.commands.list_profiles().then((result) => {
    if (result.ok) {
      const id: string | undefined = result.value[0]?.id;
      void id;
    }
  });
  bridge.commands.request_app_exit().then((result) => {
    if (result.ok) {
      const value: null = result.value;
      void value;
    }
  });
  // @ts-expect-error unknown command cannot enter the public API
  bridge.commands.exec({ cmd: 'x' });
  // @ts-expect-error resize arguments cannot be omitted
  bridge.commands.resize_session();
  // @ts-expect-error scalar types are preserved per command
  bridge.commands.resize_session({ sessionId: 's', cols: '80', rows: 24 });
  // @ts-expect-error nested arrays preserve tuple element types
  bridge.commands.save_preferences({ entries: [['k', 12]] });
  // @ts-expect-error raw wire kind differs from UI keyFile spelling
  bridge.commands.store_key_credential({ request: { id: 'x', label: '', kind: 'keyFile' } });
  bridge.commands.retrieve_key_credential({ id: 'x' }).then((result) => {
    if (result.ok && result.value) {
      // @ts-expect-error raw B response has no createdAt property
      const time = result.value.createdAt;
      void time;
    }
  });
  bridge.on('ssh-data:s', (data) => {
    const text: string = data;
    void text;
  });
  bridge.on('agent-runtime-session-event', (event) => {
    const seq: number = event.seq;
    void seq;
  });
  // @ts-expect-error internal lifecycle events never enter renderer subscriptions
  bridge.on('desktop-exit', () => {});
  // @ts-expect-error typed event payload cannot be relabelled as a number
  bridge.on('ssh-data:s', (data: number) => {
    void data;
  });
  const maximized: Promise<boolean> = bridge.window('isMaximized');
  void maximized;
  // @ts-expect-error download must name the checked version
  bridge.update('download');
  return true;
}
