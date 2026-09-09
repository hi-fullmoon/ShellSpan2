import { parentPort } from 'node:worker_threads';
import WordExtractor from 'word-extractor';

if (!parentPort) throw new Error('Document preview worker requires a parent port');
const port = parentPort;

port.once('message', (value: Uint8Array) => {
  void (async () => {
    try {
      const extracted = await new WordExtractor().extract(Buffer.from(value));
      const text = extracted.getBody({ filterUnicode: false }).replace(/\t+\n/g, '\n').trimEnd();
      port.postMessage({ text });
    } catch {
      port.postMessage({});
    }
  })();
});
