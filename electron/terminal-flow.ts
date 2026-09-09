// Credits are acknowledged only after preload has dispatched the event. This
// bounds Chromium's IPC backlog when the renderer cannot run its callbacks.
class TerminalFlow {
  send: (event: string, payload: unknown, id: number) => void;
  pause: () => void;
  resume: () => void;
  high: number;
  low: number;
  nextId: number;
  pending: Map<number, number>;
  bytes: number;
  paused: boolean;
  peakBytes: number;
  awaitingRenderer = false;
  constructor(
    send: TerminalFlow['send'],
    pause: () => void,
    resume: () => void,
    high = 512 * 1024,
    low = 256 * 1024,
  ) {
    this.send = send;
    this.pause = pause;
    this.resume = resume;
    this.high = high;
    this.low = low;
    this.nextId = 0;
    this.pending = new Map();
    this.bytes = 0;
    this.paused = false;
    this.peakBytes = 0;
  }
  push(event: string, payload: unknown) {
    const id = ++this.nextId;
    const bytes = Buffer.byteLength(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
    this.pending.set(id, bytes);
    this.bytes += bytes;
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
    if (!this.paused && this.bytes >= this.high) {
      this.paused = true;
      this.pause();
    }
    this.send(event, payload, id);
  }
  ack(id: number) {
    if (!this.pending.has(id)) return;
    this.bytes -= this.pending.get(id)!;
    this.pending.delete(id);
    if (this.paused && !this.awaitingRenderer && this.bytes <= this.low) {
      this.paused = false;
      this.resume();
    }
  }
  navigation() {
    this.pending.clear();
    this.bytes = 0;
    this.awaitingRenderer = true;
    if (!this.paused) this.pause();
    this.paused = true;
  }
  ready() {
    if (this.awaitingRenderer) {
      this.awaitingRenderer = false;
      this.paused = false;
      this.resume();
    }
  }
  reset() {
    this.pending.clear();
    this.bytes = 0;
    if (this.paused) this.resume();
    this.paused = false;
  }
}
export { TerminalFlow };
