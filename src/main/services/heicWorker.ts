import { parentPort } from 'worker_threads';

// Runs heic-convert (libheif WASM) off the main process's thread. The decode
// is fully synchronous CPU/WASM work, so on the main thread a 12-48MP HEVC HEIC
// froze IPC and the UI for seconds. The JPEG result is transferred back
// (zero-copy) instead of structured-cloned.

if (!parentPort) {
  throw new Error('heicWorker.ts must only be run as a worker_threads Worker');
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const heicConvert = require('heic-convert');

// Tells the client the script loaded fine (a load failure before this = "worker unavailable" => in-process fallback).
parentPort.postMessage({ ready: true });

type Request ={ id: number; buffer: Uint8Array; quality: number };

parentPort.on('message', async (msg: Request) => {
  const port = parentPort!;
  try {
    // structured clone turns Buffer into a plain Uint8Array; re-wrap without copying
    const input = Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
    const converted: Uint8Array = await heicConvert({ buffer: input, format: 'JPEG', quality: msg.quality });
    // Copy into a buffer that owns its whole ArrayBuffer so it can be transferred.
    const out = new Uint8Array(converted.length);
    out.set(converted);
    port.postMessage({ id: msg.id, result: out }, [out.buffer]);
  } catch (err) {
    port.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
