// HTTP Range support for serving a local file as a fetch Response — split out from main.ts's
// gphoto:// protocol handler purely so it's unit-testable without importing all of main.ts (which
// bootstraps the whole Electron app on import). Used for video playback (see
// docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.6) — a <video> element needs Range support to seek
// without downloading the whole clip first, unlike the whole-file-into-memory image responses
// the rest of the protocol handler uses (fine for a photo, wrong for a multi-minute video).
//
// Streams directly off disk (never buffers a whole range — let alone a whole file — into memory):
// for a video sitting on a OneDrive/Google Drive "Files On-Demand" placeholder, each streamed
// read only pulls the bytes actually requested, so the desktop sync client only has to fetch
// (and the video only has to wait on) that one range instead of materializing the entire file
// first — the closest this app gets to "streaming from the cloud" without a direct Graph/Drive
// API integration (see the reply covering why that's a separately-scoped, much bigger feature).
import fs from 'fs';
import { Readable } from 'stream';

export async function serveFileWithRangeSupport(filePath: string, mime: string, rangeHeader: string | null): Promise<Response> {
  const stat = await fs.promises.stat(filePath);
  const fileSize = stat.size;

  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), fileSize - 1) : fileSize - 1;
      if (start >= 0 && start <= end && start < fileSize) {
        const nodeStream = fs.createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(nodeStream) as any, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }
  }

  const nodeStream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(nodeStream) as any, {
    headers: {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(fileSize),
      'Access-Control-Allow-Origin': '*',
    },
  });
}
