import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import sharp from 'sharp';
import { probeFaceOrientation, terminateFaceDetectionWorker } from '../../src/main/services/faceDetectionWorkerClient';
import { decideRotation } from '../../src/main/services/orientationService';

// Real-detector check. The repo ships no face photo, so this only runs when
// GPHOTOS_FACE_FIXTURES points at one or more local face images (semicolon-separated, e.g. a public-domain portrait kept OUTSIDE the repo). It never touches user data.
const fixtures = (process.env.GPHOTOS_FACE_FIXTURES || '').split(';').filter((f) => f && fs.existsSync(f));

describe.skipIf(fixtures.length === 0)('probeOrientation with the real SCRFD model', () => {
  afterAll(() => terminateFaceDetectionWorker());

  for (const file of fixtures) {
    it(`finds the upright rotation of ${file.split(/[\\/]/).pop()} at every orientation`, async () => {
      const source = await sharp(file).removeAlpha().toBuffer();
      // Displayed rotation d (clockwise) -> the correcting rotation is (360 - d) % 360.
      for (const displayed of [0, 90, 180, 270] as const) {
        const buf = await sharp(source).rotate(displayed).jpeg({ quality: 88 }).toBuffer();
        const t0 = Date.now();
        const probe = await probeFaceOrientation(buf);
        const ms = Date.now() - t0;
        const decision = decideRotation(probe);
        const expected = ((360 - displayed) % 360) as 0 | 90 | 180 | 270;
        // eslint-disable-next-line no-console
        console.log(`[orient] ${file.split(/[\\/]/).pop()} displayed=${displayed} expected=${expected} -> ${decision.status}/${decision.rotation} conf=${decision.confidence.toFixed(2)} ${ms}ms`, JSON.stringify(probe.scores));
        expect(decision.rotation).toBe(expected);
        expect(decision.status).toBe(expected === 0 ? 'upright' : 'rotate');
      }
    });
  }
});
