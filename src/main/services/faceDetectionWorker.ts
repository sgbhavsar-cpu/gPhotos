import { parentPort } from 'worker_threads';
import { detectFaces, detectFaceInRegion, type DetectedFace, type DetectFacesResult } from './faceDetectionEngine';

// Runs ONNX face detection/recognition off the main process's thread.
//
// onnxruntime-node's session.run() is Promise-based but actually executes
// the model synchronously on the calling JS thread (there is no internal
// worker-thread offload for the 'cpu' execution provider) — so calling it
// directly from the main process blocks every IPC handler, menu action and
// window repaint for as long as inference takes, which is exactly what
// showed up as multi-second-to-45-second "MAIN PROCESS STALL" entries
// correlated with faces:detect-batch in main.log. Moving the whole
// detect->align->recognize pipeline into this worker thread means that
// blocking now happens on a thread nothing else depends on, so the UI stays
// responsive regardless of how long a batch takes.
//
// faceDetectionEngine.ts itself is unchanged and unaware it's running in a
// worker — it has no Electron API dependency, only path/fs/sharp/onnxruntime,
// all of which work identically inside a plain Node worker thread.

if (!parentPort) {
  throw new Error('faceDetectionWorker.ts must only be run as a worker_threads Worker');
}

type Request =
  | { id: number; kind: 'detect'; buffer: Buffer }
  | { id: number; kind: 'detectRegion'; buffer: Buffer; box: { x: number; y: number; width: number; height: number }; marginRatio?: number };

type Response =
  | { id: number; result: DetectFacesResult | DetectedFace | null }
  | { id: number; error: string };

parentPort.on('message', async (msg: Request) => {
  const port = parentPort!;
  try {
    if (msg.kind === 'detect') {
      const result = await detectFaces(msg.buffer);
      port.postMessage({ id: msg.id, result } satisfies Response);
    } else {
      const result = await detectFaceInRegion(msg.buffer, msg.box, msg.marginRatio);
      port.postMessage({ id: msg.id, result } satisfies Response);
    }
  } catch (err) {
    port.postMessage({ id: msg.id, error: String(err) } satisfies Response);
  }
});
