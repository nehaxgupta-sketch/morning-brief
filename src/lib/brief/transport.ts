// src/lib/brief/transport.ts
//
// Thin OpenAI /v1/responses helper for the writers — mirrors the carried
// callOpenAISection shape (auth, endpoint, extractJsonObject parse) but defaults
// to PLAIN generation: write-facts works from the already-fetched story, so no
// web search unless BRIEF_WRITER_SEARCH is on (snippet-thin days). Swap in your
// existing callOpenAIChat if preferred — contract is (prompt) → parsed JSON.

import { extractJsonObject } from './primitives';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const WRITER_MODEL = process.env.BRIEF_WRITER_MODEL || 'gpt-4o-mini';

// ── Cost ledger (per serverless request) ─────────────────────────────────────
// Prices are $ per 1M tokens [input, output] — APPROXIMATE; verify/adjust to
// current OpenAI rates. Covers the WRITER calls (write-facts / write-wim /
// write-deep); the fetch engine's embedding/scoring cost is tracked separately
// by your existing cost-log.
const PRICES: Record<string, [number, number]> = {
  'gpt-4o-mini': [0.15, 0.60],
  'gpt-4o': [2.50, 10.00],
};
function priceOf(model: string, inTok: number, outTok: number): number {
  const key = PRICES[model] ? model : Object.keys(PRICES).find((k) => model.startsWith(k));
  const [pin, pout] = key ? PRICES[key] : [0, 0];
  return (inTok * pin + outTok * pout) / 1e6;
}
let LEDGER: { model: string; inTok: number; outTok: number; usd: number }[] = [];
export function resetCost() { LEDGER = []; }
export function snapshotCost() {
  return LEDGER.reduce(
    (a, e) => ({ usd: a.usd + e.usd, inTok: a.inTok + e.inTok, outTok: a.outTok + e.outTok, calls: a.calls + 1 }),
    { usd: 0, inTok: 0, outTok: 0, calls: 0 },
  );
}

export async function chatJson(
  prompt: string,
  opts?: { model?: string; maxTokens?: number; tag?: string; search?: boolean },
): Promise<any> {
  const model = opts?.model || WRITER_MODEL;
  const tag = opts?.tag || 'writer';
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: opts?.maxTokens ?? 3000,
      ...(opts?.search ? { tools: [{ type: 'web_search_preview' }], tool_choice: 'auto' } : {}),
    }),
  });
  const data = await res.json();
  const text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text;
  const u = data.usage;
  if (u) LEDGER.push({ model, inTok: u.input_tokens || 0, outTok: u.output_tokens || 0, usd: priceOf(model, u.input_tokens || 0, u.output_tokens || 0) });
  console.log(`[${tag}] ${model} ${res.status}${u ? ` (in ${u.input_tokens}/out ${u.output_tokens}, $${priceOf(model, u.input_tokens || 0, u.output_tokens || 0).toFixed(4)})` : ''}`);
  if (!text) throw new Error(`[${tag}] no text in response: ${JSON.stringify(data).slice(0, 400)}`);
  return extractJsonObject(text);
}
