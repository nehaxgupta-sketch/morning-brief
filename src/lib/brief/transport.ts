// src/lib/brief/transport.ts
//
// Thin OpenAI /v1/responses helper for the writers — mirrors the carried
// callOpenAISection shape (auth, endpoint, extractJsonObject parse) but defaults
// to PLAIN generation: write-facts works from the already-fetched story, so no
// web search unless BRIEF_WRITER_SEARCH is on (snippet-thin days). Swap in your
// existing callOpenAIChat if preferred — contract is (prompt) → parsed JSON.
//
// ── Sprint 29.1 fix (write-facts 100% fallback) ──────────────────────────────
// Root cause: the writers ask for a top-level JSON ARRAY, but this file parsed
// with extractJsonObject() — an OBJECT extractor — so a valid array was dropped,
// every story fell back, and nothing threw (silent). Fix: parse ARRAY-OR-OBJECT.
// `parseModelJson` tries a plain JSON.parse first (models told "ONLY JSON" comply
// almost always), then a string-aware balanced-span extraction for array OR
// object, and only then falls back to the carried extractJsonObject. Text
// extraction is also hardened for /v1/responses (output_text, and any text part
// in any output item — matters once BRIEF_WRITER_SEARCH is on and the message is
// no longer output[0]).

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

// ── Response text extraction (hardened for /v1/responses) ────────────────────
// Handles: the convenience `output_text`; the standard message→content[].text;
// and search runs where the message isn't output[0] and content has >1 part.
function extractText(data: any): string | undefined {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
  const items = Array.isArray(data?.output) ? data.output : [];
  for (const o of items) {
    const parts = Array.isArray(o?.content) ? o.content : [];
    for (const p of parts) {
      if (typeof p?.text === 'string' && p.text.trim()) return p.text;
      if (typeof p?.text?.value === 'string' && p.text.value.trim()) return p.text.value; // some SDK shapes
    }
  }
  return undefined;
}

// Return the first balanced JSON span (array OR object), string/escape-aware so
// brackets inside string literals don't throw off the depth count.
function balancedSpan(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// Parse whatever the model returned — ARRAY or OBJECT. This is the fix: the old
// code went straight to extractJsonObject (object-only) and dropped arrays.
export function parseModelJson(text: string): any {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const span = balancedSpan(cleaned);
  if (span) { try { return JSON.parse(span); } catch { /* fall through */ } }
  return extractJsonObject(cleaned); // carried fallback (object-oriented, prose-tolerant)
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
  const text = extractText(data);
  const u = data.usage;
  if (u) LEDGER.push({ model, inTok: u.input_tokens || 0, outTok: u.output_tokens || 0, usd: priceOf(model, u.input_tokens || 0, u.output_tokens || 0) });
  console.log(`[${tag}] ${model} ${res.status}${u ? ` (in ${u.input_tokens}/out ${u.output_tokens}, $${priceOf(model, u.input_tokens || 0, u.output_tokens || 0).toFixed(4)})` : ''}`);
  if (!text) throw new Error(`[${tag}] no text in response: ${JSON.stringify(data).slice(0, 400)}`);
  return parseModelJson(text);
}
