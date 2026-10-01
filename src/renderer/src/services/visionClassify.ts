// Shared prompt + response parsing for "does this photo match this description, and what is it in
// general" batched vision calls — used by both the cloud providers (aiSearchService) and the local
// Ollama first pass (ollamaVisionService), so the two tiers ask the exact same question the exact
// same way and are validated identically.
export interface ClassifyDescribeResult {
  match: boolean;
  confidence: number; // 0..1
  caption: string;
  tags: string[];
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const asFiniteNumber = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && !v.trim() ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function buildBatchClassifyPrompt(count: number, description: string): string {
  return `You will be shown ${count} photo${count === 1 ? '' : 's'}, each labeled "Image i".
For EACH image, decide whether it matches this description: "${description}".
Also give a short general one-sentence caption and 2-6 short lowercase content-type tags for EACH
image (e.g. screenshot, receipt, document, selfie, landscape, chat-app, payment, id-card, meme) —
independent of whether it matches this description, useful for other checks on the same photo later.
Reply with ONLY a JSON array of exactly ${count} objects, no markdown fences. Each object MUST
include "image": the number from that photo's "Image i" label (1-based) — this is how your answer
gets matched back to the right photo, so get it right even if you list the objects in a different
order than you were shown them:
[{"image": 1, "match": true or false, "confidence": a number from 0 to 1, "caption": "one short sentence", "tags": ["..."]}, ...]`;
}

export function parseBatchClassifyResponse(raw: string, count: number): ClassifyDescribeResult[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== count) {
    throw new Error(`Expected ${count} classification result(s), got ${Array.isArray(parsed) ? parsed.length : typeof parsed}`);
  }

  const toResult = (p: unknown): ClassifyDescribeResult => ({
    match: !!(p as any)?.match,
    confidence: asFiniteNumber((p as any)?.confidence) ?? ((p as any)?.match ? 0.7 : 0.3),
    caption: typeof (p as any)?.caption === 'string' ? (p as any).caption : '',
    tags: asStringArray((p as any)?.tags),
  });

  // Prefer the model's own explicit "image" index over plain array position. Reported bug: a
  // local vision model's answer sometimes doesn't actually stay in the order it was asked for
  // ("one per image IN ORDER") even though the array itself is well-formed and the right length —
  // silently mismatching every caption/tag/match after the first scrambled entry to the wrong
  // photo. Only trusted when EVERY entry names a distinct, in-range image: a partially-indexed
  // response is just as likely to be a model that doesn't understand the field at all as one that's
  // genuinely confused about ordering, so mixing the two strategies for one response is riskier than
  // falling back to the old plain-position behavior for all of it.
  const indices = parsed.map((p: any) => asFiniteNumber(p?.image));
  const allValid = indices.every((n) => n !== undefined && Number.isInteger(n) && n >= 1 && n <= count)
    && new Set(indices).size === count;

  if (allValid) {
    const byIndex: ClassifyDescribeResult[] = new Array(count);
    parsed.forEach((p: any, i: number) => { byIndex[indices[i]! - 1] = toResult(p); });
    return byIndex;
  }

  return parsed.map(toResult);
}
