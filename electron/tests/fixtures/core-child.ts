#!/usr/bin/env node
import { connect } from 'node:net';
import { encode, Decoder } from '../../protocol.ts';

const mode = process.env.PROBE_MODE ?? '';
type RequestFrame = { type: string; id?: number; args?: unknown };
const pipe = process.env.SHELLSPAN_TERMINAL_PIPE;
if (!pipe) throw new Error('Missing terminal pipe');
const socket = connect(pipe, () => {
  if (mode === 'initializing' || mode === 'initializing-stall') {
    let sequence = 0;
    const timer = setInterval(() => {
      process.stdout.write(
        encode({ type: 'initializing', protocol: 1, phase: 'migration', sequence: ++sequence }),
      );
      if (mode === 'initializing-stall' || sequence === 8) {
        clearInterval(timer);
        if (mode === 'initializing')
          process.stdout.write(encode({ type: 'ready', protocol: 1, terminalChannel: true }));
      }
    }, 40);
    const decoder = new Decoder<RequestFrame>((m) => {
      if (m.type === 'shutdown') process.exit(0);
    });
    process.stdin.on('data', (d) => decoder.push(typeof d === 'string' ? Buffer.from(d) : d));
    return;
  }
  process.stdout.write(
    encode({
      type: 'ready',
      protocol: mode === 'bad-version' ? 2 : 1,
      terminalChannel: mode !== 'missing-terminal',
    }),
  );
  if (mode === 'truncated') {
    process.stdout.write(Buffer.from([0, 0, 0, 50, 123]), () => process.exit(0));
  } else if (mode === 'exit') setTimeout(() => process.exit(9), 100);
  else if (mode === 'stalled') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  } else if (mode === 'echo') {
    const decoder = new Decoder<RequestFrame>((m) => {
      if (m.type === 'shutdown') process.exit(0);
      process.stdout.write(encode({ type: 'response', id: m.id, ok: true, value: m.args }));
    });
    process.stdin.on('data', (d) => decoder.push(typeof d === 'string' ? Buffer.from(d) : d));
  } else if (['terminal-eof', 'terminal-sequence', 'terminal-truncated'].includes(mode)) {
    setTimeout(() => {
      if (mode === 'terminal-eof') socket.end();
      else if (mode === 'terminal-sequence')
        socket.write(encode({ type: 'event', event: 'ssh-data:s', payload: 'x', terminalSeq: 2 }));
      else socket.end(Buffer.from([0, 0, 0, 20, 123]));
    }, 100);
    setInterval(() => {}, 1000);
  } else process.stdin.resume();
});
