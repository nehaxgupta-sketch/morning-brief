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
  console.log(`[${tag}] ${model} ${res.status}${u ? ` (in ${u.input_tokens}/out ${u.output_tokens})` : ''}`);
  if (!text) throw new Error(`[${tag}] no text in response: ${JSON.stringify(data).slice(0, 400)}`);
  // TODO(cost): route `u` through @/lib/cost-log (function names not reproduced here).
  return extractJsonObject(text);
}
