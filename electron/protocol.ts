const MAX_FRAME = 64 * 1024 * 1024;
function encode(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length === 0 || body.length > MAX_FRAME) throw new Error('Invalid native frame length');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
class Decoder<T = unknown> {
  onFrame: (frame: T) => void;
  parts: Buffer[];
  bytes: number;
  expected: number | null;
  constructor(onFrame: (frame: T) => void) {
    this.onFrame = onFrame;
    this.parts = [];
    this.bytes = 0;
    this.expected = null;
  }
  take(length: number): Buffer {
    if (this.parts[0].length === length) {
      this.bytes -= length;
      return this.parts.shift()!;
    }
    if (this.parts[0].length > length) {
      const out = this.parts[0].subarray(0, length);
      this.parts[0] = this.parts[0].subarray(length);
      this.bytes -= length;
      return out;
    }
    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const part = this.parts[0];
      const n = Math.min(part.length, length - offset);
      part.copy(out, offset, 0, n);
      offset += n;
      if (n === part.length) this.parts.shift();
      else this.parts[0] = part.subarray(n);
    }
    this.bytes -= length;
    return out;
  }
  push(chunk: Buffer) {
    if (!chunk.length) return;
    this.parts.push(chunk);
    this.bytes += chunk.length;
    while (true) {
      if (this.expected === null) {
        if (this.bytes < 4) return;
        this.expected = this.take(4).readUInt32BE();
        if (!this.expected || this.expected > MAX_FRAME)
          throw new Error('Invalid native frame length');
      }
      if (this.bytes < this.expected) return;
      const body = this.take(this.expected);
      this.expected = null;
      this.onFrame(JSON.parse(body.toString('utf8')));
    }
  }
  finish() {
    if (this.bytes || this.expected !== null) throw new Error('Truncated native frame');
  }
}
export { encode, Decoder, MAX_FRAME };
