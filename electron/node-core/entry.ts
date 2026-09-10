#!/usr/bin/env node
import { connect } from 'node:net';
import { once } from 'node:events';
import { Decoder, encode } from '../protocol.ts';
import { dispatchNodeCommand } from './dispatcher.ts';
import { NodeCoreEventSender } from './events.ts';
import { NodeCoreState } from './state.ts';
import { validateCommand as validateCommandForCore } from '../validation.ts';
import { redactDiagnostic } from './redaction.ts';

type RequestFrame = {
  type: 'request' | 'validate' | 'migration-read';
  id: number;
  command: string;
  args: object;
};
type InputFrame = RequestFrame | { type: 'shutdown' };

function queuedWriter(stream: NodeJS.WritableStream) {
  let queue = Promise.resolve();
  return (value: unknown) => {
    const frame = encode(value);
    const write = queue.then(async () => {
      if (!stream.write(frame)) await once(stream, 'drain');
    });
    queue = write.catch(() => {});
    return write;
  };
}

const pipe = process.env.SHELLSPAN_TERMINAL_PIPE;
if (!pipe) throw new Error('Missing terminal pipe');

const state = new NodeCoreState(process.env);
const terminalSocket = connect(pipe);
const sendControl = queuedWriter(process.stdout);
const sendTerminal = queuedWriter(terminalSocket);
const events = new NodeCoreEventSender(sendControl, sendTerminal, terminalSocket);
let shutdownStarted = false;

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await state.stop();
  await sendControl({ type: 'stopped' });
  state.lifecycle = 'stopped';
  terminalSocket.end();
  process.stdin.pause();
}

function protocolRequest(frame: InputFrame): asserts frame is RequestFrame {
  if (
    (frame.type !== 'request' && frame.type !== 'validate' && frame.type !== 'migration-read') ||
    !Number.isSafeInteger(frame.id) ||
    typeof frame.command !== 'string' ||
    !frame.args ||
    Object.prototype.toString.call(frame.args) !== '[object Object]'
  )
    throw new Error('Invalid Node core request');
}

const decoder = new Decoder<InputFrame>((frame) => {
  if (frame.type === 'shutdown') {
    void shutdown();
    return;
  }
  protocolRequest(frame);
  const signal = state.begin(frame.id);
  void (async () => {
    try {
      const value =
        frame.type === 'validate'
          ? (validateCommandForCore(frame.command, frame.args), null)
          : await dispatchNodeCommand(frame.command, frame.args, {
              state,
              events,
              env: process.env,
              signal,
            });
      if (!signal.aborted) await sendControl({ type: 'response', id: frame.id, ok: true, value });
    } catch (error) {
      if (!signal.aborted)
        await sendControl({
          type: 'response',
          id: frame.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      state.finish(frame.id);
    }
  })();
});

terminalSocket.once('connect', async () => {
  await state.initialize(events);
  state.lifecycle = 'ready';
  void sendControl({ type: 'ready', protocol: 1, terminalChannel: true });
  process.stdin.on('data', (data) =>
    decoder.push(Buffer.isBuffer(data) ? data : Buffer.from(data)),
  );
  process.stdin.on('end', () => {
    decoder.finish();
    if (!shutdownStarted) throw new Error('Node core control channel ended');
  });
  process.stdin.resume();
});

terminalSocket.on('error', (error) => {
  throw error;
});

process.on('uncaughtException', (error) => {
  process.stderr.write(
    `${JSON.stringify({ type: 'log', level: 'error', message: redactDiagnostic(error.message), target: 'node-core' })}\n`,
  );
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  throw reason instanceof Error ? reason : new Error(String(reason));
});
