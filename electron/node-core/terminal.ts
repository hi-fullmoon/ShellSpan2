import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { NodeCoreEventSender } from './events.ts';
import type { ConnectionRequest, SshConnector } from './ssh.ts';

type Status = 'connecting' | 'connected' | 'disconnected' | 'error';
type Session = {
  id: string;
  process: {
    pid?: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
  };
  status: { sessionId: string; status: Status; message?: string };
  identity: { title: string; host: string; port: number; username: string };
  ready: boolean;
  paused: boolean;
  buffered: string[];
  bufferedBytes: number;
  closed: boolean;
  guardian?: ChildProcess;
};

const MAX_GATED_OUTPUT = 8 * 1024 * 1024;

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly events: NodeCoreEventSender,
    private readonly ssh?: SshConnector,
  ) {}

  async createLocal(cols: number, rows: number) {
    const id = randomUUID();
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
    const title = basename(shell).replace(/\.exe$/i, '') || 'Local';
    const identity = {
      title,
      host: 'local',
      port: 0,
      username: process.env[process.platform === 'win32' ? 'USERNAME' : 'USER'] || 'local',
    };
    let child: IPty;
    try {
      child = pty.spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
        cols: Math.max(1, cols),
        rows: Math.max(1, rows),
        cwd: process.env.HOME || process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'ShellSpan',
          TERM_PROGRAM_VERSION: process.env.SHELLSPAN_APP_VERSION || '0.0.0',
        } as Record<string, string>,
        name: 'xterm-256color',
      });
    } catch (error) {
      throw new Error(
        `failed to start local shell: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const session: Session = {
      id,
      process: child,
      status: { sessionId: id, status: 'connected', message: 'local shell ready' },
      identity,
      ready: false,
      paused: false,
      buffered: [],
      bufferedBytes: 0,
      closed: false,
    };
    session.guardian = spawn(
      process.execPath,
      [join(__dirname, 'pty-guardian.js'), String(process.pid), String(child.pid)],
      {
        detached: false,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    session.guardian.unref();
    this.sessions.set(id, session);
    child.onData((data) => this.output(session, data));
    child.onExit(
      () => void this.finish(session, session.closed ? 'local shell closed' : 'local shell exited'),
    );
    await this.events.emit('ssh-status', session.status);
    return { sessionId: id, ...identity };
  }

  async createRemote(
    request: ConnectionRequest & { name: string; terminalCols: number; terminalRows: number },
    signal?: AbortSignal,
  ) {
    if (!this.ssh) throw new Error('SSH connector is unavailable');
    const id = randomUUID();
    await this.events.emit('ssh-status', {
      sessionId: id,
      status: 'connecting',
      message: 'connecting',
    });
    let connection: Awaited<ReturnType<SshConnector['connect']>> | undefined;
    try {
      connection = await this.ssh.connect(request, signal);
      const stream = await new Promise<import('ssh2').ClientChannel>((resolve, reject) =>
        connection!.client.shell(
          {
            term: 'xterm-256color',
            cols: Math.max(1, request.terminalCols),
            rows: Math.max(1, request.terminalRows),
          },
          (error, channel) => (error ? reject(error) : resolve(channel)),
        ),
      );
      const identity = {
        title: request.name,
        host: request.host,
        port: request.port,
        username: request.username,
      };
      const session: Session = {
        id,
        process: {
          write: (data) => {
            stream.write(data);
          },
          resize: (cols, rows) => {
            stream.setWindow(rows, cols, 0, 0);
          },
          kill: () => {
            stream.close();
            this.ssh!.close(connection!);
          },
        },
        status: { sessionId: id, status: 'connected', message: 'shell ready' },
        identity,
        ready: false,
        paused: false,
        buffered: [],
        bufferedBytes: 0,
        closed: false,
      };
      this.sessions.set(id, session);
      const decoder = new StringDecoder('utf8');
      stream.on('data', (data: Buffer) => this.output(session, decoder.write(data)));
      stream.stderr.on('data', (data: Buffer) => this.output(session, decoder.write(data)));
      stream.on('close', () => {
        const tail = decoder.end();
        if (tail) this.output(session, tail);
        void this.finish(session, session.closed ? 'session closed' : 'remote shell closed');
        this.ssh!.close(connection!);
      });
      await this.events.emit('ssh-status', session.status);
      return { sessionId: id, ...identity };
    } catch (error) {
      if (connection) this.ssh.close(connection);
      await this.events.emit('ssh-status', {
        sessionId: id,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  getStatus(sessionId: string) {
    return { ...this.session(sessionId).status };
  }

  markReady(sessionId: string) {
    const session = this.session(sessionId);
    session.ready = true;
    void this.flush(session);
    return null;
  }

  setPaused(sessionId: string, paused: boolean) {
    const session = this.session(sessionId);
    session.paused = paused;
    if (!paused) void this.flush(session);
    return null;
  }

  write(sessionId: string, data: string) {
    this.session(sessionId).process.write(data);
    return null;
  }

  resize(sessionId: string, cols: number, rows: number) {
    this.session(sessionId).process.resize(Math.max(1, cols), Math.max(1, rows));
    return null;
  }

  close(sessionId: string) {
    const session = this.session(sessionId);
    session.closed = true;
    this.kill(session);
    return null;
  }

  async stop() {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      session.closed = true;
      this.kill(session);
    }
    await new Promise((resolve) => setTimeout(resolve, sessions.length ? 50 : 0));
    this.sessions.clear();
  }

  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`session not found: ${id}`);
    return session;
  }

  private output(session: Session, data: string) {
    if (!session.ready || session.paused) {
      session.buffered.push(data);
      session.bufferedBytes += Buffer.byteLength(data);
      if (session.bufferedBytes > MAX_GATED_OUTPUT) {
        session.ready = true;
        void this.flush(session);
      }
      return;
    }
    void this.events.emit(`ssh-data:${session.id}`, data);
  }

  private async flush(session: Session) {
    if (!session.ready || session.paused) return;
    for (const chunk of session.buffered.splice(0))
      await this.events.emit(`ssh-data:${session.id}`, chunk);
    session.bufferedBytes = 0;
  }

  private async finish(session: Session, reason: string) {
    if (!this.sessions.delete(session.id)) return;
    session.guardian?.kill();
    session.status = { sessionId: session.id, status: 'disconnected', message: reason };
    await this.flush(session);
    await this.events.emit('ssh-status', session.status);
    await this.events.emit('ssh-closed', {
      sessionId: session.id,
      identity: session.identity,
      reason,
      reasonKind: session.closed ? 'local_close' : 'remote_exit',
      retryable: false,
    });
  }

  private kill(session: Session) {
    const pid = session.process.pid;
    if (process.platform === 'win32' && pid !== undefined) {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          session.process.kill();
        } catch {}
        session.guardian?.kill();
      };
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', finish);
      killer.once('close', finish);
      setTimeout(finish, 1000).unref();
      return;
    }
    if (process.platform !== 'win32' && session.process.pid !== undefined) {
      try {
        process.kill(-session.process.pid, 'SIGTERM');
      } catch {}
    }
    try {
      session.process.kill();
    } catch {}
    session.guardian?.kill();
    setTimeout(() => {
      if (process.platform !== 'win32' && pid !== undefined) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }
    }, 500).unref();
  }
}
