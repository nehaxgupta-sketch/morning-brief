// src/lib/cost-log.ts
//
// Sprint 11 — per-API-call cost capture. One row per API call goes to
// brief_costs in Supabase. Daily totals are computed at read time on the
// /admin dashboard.
//
// Sprint 12 — added 'industry' tail phase + gpt-4o-mini-search-preview model.
// Sprint 13 — added 'storyline' phase (Follow a Story: tagging, backfill,
//             fallback fetch, story-so-far regen).
// Sprint 14 — added 'desk' phase (Desks: two-pass fetch, writer, scorer).
// Sprint 14.3 — added Perplexity Sonar pricing so sonar-pro (the main fetch
//             model) is costed correctly instead of falling back to the
//             gpt-4o-mini rate. Despite the name, logOpenAICost now covers
//             every provider whose model appears in PRICING.
//
// Fire-and-forget: writes are awaited but failure is logged-only, never
// thrown. We don't want telemetry failures to take down the brief pipeline.
//
// Pricing snapshot last reviewed June 2026. Update PRICING when prices
// change. Sources: openai.com/api/pricing, docs.perplexity.ai/guides/pricing.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// USD per 1M tokens. Reasoning tokens are billed at the output rate.
//
// OpenAI
// ------
// Sprint 12 note: gpt-4o-mini-search-preview has the same token rates as
// gpt-4o-mini ($0.15 in / $0.60 out per 1M). It also charges a per-search
// fee (~$25 per 1K searches per OpenAI's pricing page). The per-search fee
// is NOT captured here — it would require OpenAI usage API integration. For
// our volume (~20 tail fetches × 2-3 searches each = 40-60 searches/day) the
// per-search fee is ≈ $0.0015/day, well within rounding error. Revisit if
// tail fetch volume grows past a few hundred per day.
// Sprint 14 note: desks add 2 search calls per subscribed desk per day
// (≤12 calls at full catalog) — still within rounding error.
//
// Perplexity (Sprint 14.3)
// ------------------------
// sonar-pro is the main-fetch model. Token rates below are per 1M and were
// verified June 2026 ($3 in / $15 out). Like OpenAI's search models, Sonar
// also charges a per-request search fee (~$5–$14 per 1K requests for sonar-pro,
// scaling with search-context size). That per-request fee is NOT captured here
// for the same reason as OpenAI's — at our volume (a handful of fetch calls a
// day) it's ≈ $0.01–0.05/day. Revisit if Perplexity call volume grows.
// If you adopt other Sonar tiers, add them here after checking the current
// rate: e.g. sonar-reasoning-pro (~$2 in / $8 out) and sonar-reasoning
// (~$1 in / $5 out) — verify before trusting these.
const PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-5':                        { input: 1.25,  output: 10.00 },
  'gpt-4o':                       { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':                  { input: 0.15,  output: 0.60 },
  'gpt-4o-mini-search-preview':   { input: 0.15,  output: 0.60 },
  // Perplexity (Sonar)
  'sonar-pro':                    { input: 3.00,  output: 15.00 },
  'sonar':                        { input: 1.00,  output: 1.00 },
  // Anthropic (Sprint 26)
  // ------------------------
  // personalise-briefs.tsx's city/interest editors call the Anthropic Messages
  // API with ANTHROPIC_CITY_MODEL (default 'claude-sonnet-4-6'). That model
  // string was missing here, so EVERY personalise run logged
  //   [cost] Unknown model "claude-sonnet-4-6" — using gpt-4o-mini rate
  // and the spend dashboard under-reported the largest per-user cost. This map
  // is the SHARED util imported by generate-brief, personalise-briefs,
  // generate-desks and score-extras, so adding the string here fixes the
  // telemetry for all four at once. Standard Claude Sonnet token pricing
  // ($3 in / $15 out per 1M) — VERIFY against anthropic.com/pricing if a live
  // run still logs "Unknown model" or the rate has since changed.
  'claude-sonnet-4-6':            { input: 3.00,  output: 15.00 },
  // OpenAI embeddings (Sprint 26 — honesty fix #8)
  // ------------------------
  // rss-retrieval embed() (text-embedding-3-small) powers near-dup + event
  // clustering every fetch but never wrote a cost row. It now logs under
  // phase:'embed'. Embeddings are INPUT-ONLY (no output/reasoning tokens);
  // $0.02 per 1M input tokens. ~$0.01/run at our volume.
  'text-embedding-3-small':       { input: 0.02,  output: 0.00 },
};

function getISTDate(): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

export type CostPhase =
  | 'fetch'      // main web_search fetch (base brief)
  | 'lens'       // standalone lens fallback
  | '5min'       // The Brief writer
  | '10min'      // The Daily writer
  | 'deep'       // The Editorial writer
  | 'city'       // per-city tail fetch (Sprint 12: now via gpt-4o-mini-search-preview)
  | 'interest'   // per-interest tail fetch (Sprint 12)
  | 'industry'   // per-industry tail fetch (Sprint 12)
  | 'storyline'  // Follow a Story: tag/detect, backfill, fallback fetch, story-so-far regen (Sprint 13)
  | 'desk'       // Desks: per-desk two-pass fetch + writer + scorer (Sprint 14)
  | 'embed'      // event-clustering embeddings — text-embedding-3-small (Sprint 26)
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
// These helpers normalise them. Perplexity's response mirrors OpenAI's
// chat-completion shape (usage.prompt_tokens / usage.completion_tokens), so
// extractUsageFromChatCompletion works for sonar models too.

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
