import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { encode, Decoder } from './protocol.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server, Socket } from 'node:net';
import type { CoreMessage, CoreReady, CoreResponse } from './types.ts';
import type { CoreExitInfo } from './core-backend.ts';

class CoreProcessHost extends EventEmitter<{
  log: [record: { level: string; message: string; target?: string }];
  event: [event: string, payload: unknown];
  initializing: [progress: { phase: string; sequence: number }];
  stopped: [];
  exit: [info: CoreExitInfo];
  failure: [error: Error];
}> {
  nextId: number;
  pending: Map<
    number,
    { resolve: (response: CoreResponse) => void; reject: (error: unknown) => void }
  >;
  stopping: boolean;
  failure: Error | null;
  pipeDirectory: string | null;
  pipePath: string;
  terminalSequence: number;
  terminalDecoder: Decoder<CoreMessage>;
  terminalServer: Server;
  terminalSocket?: Socket;
  terminalEnded = false;
  child!: ChildProcessWithoutNullStreams;
  spawned: Promise<void>;
  writeQueue: Promise<void>;
  ready: Promise<CoreReady>;
  resolveReady!: (message: CoreReady) => void;
  rejectReady!: (error: unknown) => void;
  readyMessage?: CoreReady;
  startupSequence: number;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  decoder!: Decoder<CoreMessage>;
  stderrText = '';
  exitInfo: CoreExitInfo | null = null;
  exitError: Error | null = null;
  constructor(binary: string, env: NodeJS.ProcessEnv, childArgs: readonly string[] = []) {
    super();
    this.nextId = 0;
    this.pending = new Map();
    this.stopping = false;
    this.failure = null;
    this.pipeDirectory =
      process.platform === 'win32'
        ? null
        : fs.mkdtempSync(path.join(os.tmpdir(), 'shellspan-ipc-'));
    this.pipePath = this.pipeDirectory
      ? path.join(this.pipeDirectory, 'terminal')
      : `\\\\.\\pipe\\shellspan-${randomUUID()}`;
    this.terminalSequence = 0;
    this.terminalDecoder = new Decoder<CoreMessage>((message) => {
      if (
        message.type !== 'event' ||
        !(
          message.event?.startsWith('ssh-data:') ||
          ['ssh-status', 'ssh-closed', 'ssh-session-error'].includes(message.event)
        )
      )
        throw new Error('Invalid Core terminal record');
      if (
        !Number.isSafeInteger(message.terminalSeq) ||
        message.terminalSeq !== this.terminalSequence + 1
      )
        throw new Error('Out-of-order Core terminal frame');
      this.terminalSequence = message.terminalSeq;
      this.receive(message);
    });
    this.terminalServer = net.createServer((socket) => {
      if (this.terminalSocket) {
        socket.destroy();
        return;
      }
      this.terminalSocket = socket;
      this.terminalEnded = false;
      if (this.readyMessage) this.finishReady();
      socket.on('data', (data) => {
        try {
          this.terminalDecoder.push(typeof data === 'string' ? Buffer.from(data) : data);
        } catch (error) {
          this.fail(error);
        }
      });
      socket.on('end', () => {
        try {
          this.terminalDecoder.finish();
        } catch (error) {
          this.fail(error);
        }
        this.terminalEnded = true;
        if (!this.stopping && !this.exitInfo && this.child?.exitCode === null)
          this.fail(new Error('Core terminal channel ended'));
        this.maybeExit();
      });
      socket.on('error', (error) => this.fail(error));
      socket.on('close', () => {
        this.terminalEnded = true;
        this.maybeExit();
      });
    });
    this.spawned = new Promise<void>((resolve, reject) => {
      this.terminalServer.once('error', reject);
      this.terminalServer.listen(this.pipePath, () => {
        this.child = spawn(binary, childArgs, {
          env: { ...env, SHELLSPAN_TERMINAL_PIPE: this.pipePath },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        this.attachChild();
        resolve();
      });
    });
    this.spawned.catch((error) => this.fail(error));
    this.writeQueue = Promise.resolve();
    this.ready = new Promise<CoreReady>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A readiness failure can precede the caller attaching its handler.
    this.ready.catch(() => {});
    this.startupSequence = 0;
    this.armStartupDeadline();
  }
  armStartupDeadline() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail(new Error('Core process startup made no progress for 30 seconds')),
      30000,
    );
  }
  attachChild() {
    this.decoder = new Decoder<CoreMessage>((message) => this.receive(message));
    this.child.stdout.on('data', (data) => {
      try {
        this.decoder.push(data);
      } catch (error) {
        this.fail(error);
      }
    });
    this.child.stdout.on('end', () => {
      try {
        this.decoder.finish();
      } catch (error) {
        this.fail(error);
      }
    });
    this.stderrText = '';
    const stderrDecoder = new StringDecoder('utf8');
    const stderrLine = (line: string) => {
      try {
        const record = JSON.parse(line);
        if (record.type === 'log') {
          this.receive(record);
          return;
        }
      } catch {}
      this.emit('log', { level: 'error', message: line });
    };
    this.child.stderr.on('data', (data) => {
      this.stderrText += stderrDecoder.write(data);
      let newline;
      while ((newline = this.stderrText.indexOf('\n')) !== -1) {
        stderrLine(this.stderrText.slice(0, newline));
        this.stderrText = this.stderrText.slice(newline + 1);
      }
      if (Buffer.byteLength(this.stderrText) > 64 * 1024 * 1024)
        this.fail(new Error('Oversized Core diagnostic record'));
    });
    this.child.stderr.on('end', () => {
      this.stderrText += stderrDecoder.end();
      if (this.stderrText) stderrLine(this.stderrText);
      this.stderrText = '';
    });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.once('close', () => this.cleanupTransport(false));
    this.child.on('exit', (code, signal) => {
      clearTimeout(this.timer);
      clearTimeout(this.killTimer);
      this.cleanupTransport(false);
      const error = new Error(`Core process exited (${code ?? signal})`);
      this.exitError = error;
      this.rejectReady(error);
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      this.exitInfo = { code, signal, expected: this.stopping };
      this.maybeExit();
    });
  }
  receive(message: CoreMessage) {
    if (message.type === 'initializing') {
      if (this.failure || this.readyMessage) return;
      if (
        message.protocol !== 1 ||
        message.phase !== 'migration' ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence <= this.startupSequence
      )
        return this.fail(new Error('Invalid Core initialization progress'));
      this.startupSequence = message.sequence;
      this.armStartupDeadline();
      this.emit('initializing', { phase: message.phase, sequence: message.sequence });
      return;
    }
    if (message.type === 'ready') {
      if (message.protocol !== 1) return this.fail(new Error('Incompatible Core protocol'));
      if (message.terminalChannel !== true)
        return this.fail(new Error('Core process lacks a dedicated terminal channel'));
      this.readyMessage = message;
      if (!message.terminalChannel || this.terminalSocket) this.finishReady();
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(
        message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error },
      );
    } else if (message.type === 'event') this.emit('event', message.event, message.payload);
    else if (message.type === 'log') this.emit('log', message);
    else if (message.type === 'stopped') this.emit('stopped');
  }
  finishReady() {
    clearTimeout(this.timer);
    if (this.readyMessage) this.resolveReady(this.readyMessage);
  }
  maybeExit() {
    if (!this.exitInfo || (this.terminalSocket && !this.terminalEnded)) return;
    const info = this.exitInfo;
    this.exitInfo = null;
    this.failure ||= this.exitError;
    this.emit('exit', info);
  }
  cleanupTransport(destroySocket = true) {
    this.terminalServer.close();
    if (destroySocket) this.terminalSocket?.destroy();
    if (this.pipeDirectory) fs.rmSync(this.pipeDirectory, { recursive: true, force: true });
  }
  fail(error: unknown) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.cleanupTransport();
    clearTimeout(this.timer);
    this.rejectReady(error);
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    if (!this.stopping) this.emit('failure', this.failure);
    this.child?.kill();
    this.killTimer = setTimeout(() => {
      if (this.child && this.child.exitCode === null && !this.child.signalCode)
        this.child.kill('SIGKILL');
    }, 1000);
  }
  async send(value: unknown) {
    if (this.failure) return Promise.reject(this.failure);
    const frame = encode(value);
    const write = this.writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.failure) return reject(this.failure);
          this.child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
        }),
    );
    this.writeQueue = write.catch(() => {});
    return write;
  }
  async invoke(command: string, args: object = {}, type = 'request'): Promise<CoreResponse> {
    await this.ready;
    if (this.failure || this.stopping || this.child.exitCode !== null || this.child.signalCode)
      throw new Error('Core process is unavailable');
    if (this.pending.size >= 4096) throw new Error('Too many pending Core requests');
    const id = ++this.nextId;
    const response = new Promise<CoreResponse>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    // Do not await a backpressured write before observing process failure.
    this.send({ type, id, command, args }).catch((error) => {
      this.pending.get(id)?.reject(error);
      this.pending.delete(id);
    });
    return response;
  }
  validate(command: string, args: object = {}) {
    return this.invoke(command, args, 'validate');
  }
  async stop() {
    await this.spawned.catch(() => {});
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.timer);
    this.rejectReady(new Error('Core process stopped'));
    this.terminalSocket?.resume();
    if (!this.child || this.child.exitCode !== null || this.child.signalCode) {
      this.cleanupTransport();
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        this.removeListener('exit', finish);
        this.removeListener('stopped', stopped);
        resolve();
      };
      const stopped = () => {
        this.child.kill();
      };
      const timeout = setTimeout(() => {
        this.child.kill('SIGKILL');
        finish();
      }, 5000);
      this.once('exit', finish);
      this.once('stopped', stopped);
      this.send({ type: 'shutdown' }).then(
        () => this.child.stdin.end(),
        () => {
          this.child.kill();
        },
      );
    });
  }
}
export { CoreProcessHost };
