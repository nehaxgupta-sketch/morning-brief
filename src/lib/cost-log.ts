// src/lib/cost-log.ts
//
// Sprint 11 — per-OpenAI-call cost capture. One row per API call goes to
// brief_costs in Supabase. Daily totals are computed at read time on the
// /admin dashboard.
//
// Sprint 12 — added 'industry' tail phase + gpt-4o-mini-search-preview model.
//
// Fire-and-forget: writes are awaited but failure is logged-only, never
// thrown. We don't want telemetry failures to take down the brief pipeline.
//
// Pricing snapshot last reviewed June 2026. Update PRICING when OpenAI
// prices change. Source: openai.com/pricing.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// USD per 1M tokens. Reasoning tokens are billed at the output rate.
//
// Sprint 12 note: gpt-4o-mini-search-preview has the same token rates as
// gpt-4o-mini ($0.15 in / $0.60 out per 1M). It also charges a per-search
// fee (~$25 per 1K searches per OpenAI's pricing page). The per-search fee
// is NOT captured here — it would require OpenAI usage API integration. For
// our volume (~20 tail fetches × 2-3 searches each = 40-60 searches/day) the
// per-search fee is ≈ $0.0015/day, well within rounding error. Revisit if
// tail fetch volume grows past a few hundred per day.
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-5':                        { input: 1.25,  output: 10.00 },
  'gpt-4o':                       { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':                  { input: 0.15,  output: 0.60 },
  'gpt-4o-mini-search-preview':   { input: 0.15,  output: 0.60 },
};

function getISTDate(): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

export type CostPhase =
  | 'fetch'      // gpt-5 web_search fetch (base brief)
  | 'lens'       // standalone lens fallback
  | '5min'       // The Brief writer
  | '10min'      // The Daily writer
  | 'deep'       // The Editorial writer
  | 'city'       // per-city tail fetch (Sprint 12: now via gpt-4o-mini-search-preview)
  | 'interest'   // per-interest tail fetch (Sprint 12)
  | 'industry'   // per-industry tail fetch (Sprint 12 — NEW)
  | 'score';     // auto-scorer (rubric)

export function calculateCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number = 0,
): number {
  const p = PRICING[model];
  if (!p) {
    console.warn(`[cost] Unknown model "${model}" — using gpt-4o-mini rate as fallback.`);
    const f = PRICING['gpt-4o-mini'];
    const inputCost = (inputTokens / 1_000_000) * f.input;
    const outputCost = ((outputTokens + reasoningTokens) / 1_000_000) * f.output;
    return Number((inputCost + outputCost).toFixed(6));
  }
  const inputCost = (inputTokens / 1_000_000) * p.input;
  const outputCost = ((outputTokens + reasoningTokens) / 1_000_000) * p.output;
  return Number((inputCost + outputCost).toFixed(6));
}

export async function logOpenAICost(args: {
  phase: CostPhase;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  detail?: string;
}): Promise<void> {
  const reasoning = args.reasoningTokens || 0;
  const usd = calculateCostUSD(args.model, args.inputTokens, args.outputTokens, reasoning);
  try {
    const { error } = await supabase.from('brief_costs').insert({
      date: getISTDate(),
      phase: args.phase,
      model: args.model,
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      reasoning_tokens: reasoning,
      usd_cost: usd,
      detail: args.detail || null,
    });
    if (error) {
      console.warn(`[cost] insert failed (${args.phase}/${args.model}): ${error.message}`);
    } else {
      console.log(`[cost] ${args.phase}/${args.model} — in=${args.inputTokens} out=${args.outputTokens} reason=${reasoning} usd=$${usd}`);
    }
  } catch (e: any) {
    console.warn(`[cost] insert threw (${args.phase}/${args.model}): ${e?.message || e}`);
  }
}

// ─── Extractors ─────────────────────────────────────────────────────────────
//
// OpenAI's two endpoints return token counts in slightly different shapes.
// These helpers normalise them.

export function extractUsageFromChatCompletion(data: any): {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
} {
  const u = data?.usage || {};
  return {
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens || 0,
  };
}

export function extractUsageFromResponses(data: any): {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
} {
  const u = data?.usage || {};
  return {
    inputTokens: u.input_tokens || u.prompt_tokens || 0,
    outputTokens: u.output_tokens || u.completion_tokens || 0,
    reasoningTokens:
      u.output_tokens_details?.reasoning_tokens
      || u.reasoning_tokens
      || 0,
  };
}
