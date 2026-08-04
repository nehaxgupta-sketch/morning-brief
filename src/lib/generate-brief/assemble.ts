// src/lib/generate-brief/assemble.ts
//
// Modularization stage 6 - persistence, push, content hygiene, and orchestration:
// saveBriefToSupabase + sendPushNotification (§20), dead-link drop / cross-section
// dedup / sanitize (§21), and runWriterForEdition (§22) which wires the writers,
// repair, coherence, backfill, validation and invariant check in order. Imports the
// writer functions it drives from ./writers. Only `export` added to declarations.

import {
  getISTDate,
  normaliseUrlForCompare,
} from '@/lib/generate-brief/utils';
import type {
  Edition,
  RawStories,
  BriefContent,
} from '@/lib/generate-brief/types';
import {
  ONESIGNAL_APP_ID,
  ONESIGNAL_REST_API_KEY,
  supabase,
} from '@/lib/generate-brief/env';
import {
  PLACEMENT_V2,
  PLACEMENT_OVERLAY,
  buildSubset,
} from '@/lib/generate-brief/quality';
import {
  writeQuickEdition,
  writeDailyEdition,
  writeEditorialEdition,
  backfillToSubsetCounts,
  rewriteTemplateWhys,
  COHERENCE_ENFORCE,
  COHERENCE_BACKFILL_GUARD,
  runCoherenceCheck,
  applyCoherenceDrops,
  repairCommonOmissions,
  validateBrief,
  stripNonWhitelistedFromContent,
  fetchPreviousBrief,
  BRIEF_INVARIANTS,
  BRIEF_INVARIANTS_HALT,
  checkBriefInvariants,
} from '@/lib/generate-brief/writers';

// ============================================================================
// SECTION 20:  PERSIST & PUSH
// ----------------------------------------------------------------------------
// Writes the validated brief to the briefs table and sends the OneSignal push
// for the top headline.
// Fns:   saveBriefToSupabase, sendPushNotification
// Flags: ONESIGNAL_* (env)
// ============================================================================
export async function saveBriefToSupabase(
  edition: Edition,
  rawStories: RawStories | null,
  content: BriefContent | null,
  lens: any,
  status: 'ready' | 'fallback' | 'failed' | 'pending',
) {
  const today = getISTDate();
  // Sprint 8: lens lives inside the content JSONB (no DB migration needed).
  // We merge it in here at save time so writers don't need to know about it.
  const contentWithLens = content
    ? { ...content, lens: lens ?? (content as any).lens ?? null }
    : null;
  const { error } = await supabase
    .from('briefs')
    .upsert(
      {
        date: today,
        edition,
        status,
        raw_stories: rawStories,
        content: contentWithLens,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'date,edition' },
    );
  if (error) throw new Error(`Supabase save failed: ${error.message}`);
  console.log(`Saved ${edition} for ${today} — status ${status}`);
}

// ─── Push notification ──────────────────────────────────────────────────────

export async function sendPushNotification(topHeadline: string) {
  const response = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      included_segments: ['All'],
      headings: { en: '☕ Your Morning Brief is ready' },
      contents: { en: topHeadline },
      url: 'https://morning-brief-liart.vercel.app/brief',
      small_icon: 'ic_stat_onesignal_default',
    }),
  });

  const data = await response.json();
  if (data.errors) throw new Error(`OneSignal error: ${JSON.stringify(data.errors)}`);
  console.log(`Push sent. Recipients: ${data.recipients ?? 'unknown'}, ID: ${data.id}`);
  return data;
}

// ─── Mode-based architecture ────────────────────────────────────────────────
//
// Why modes exist: Vercel Hobby plan caps serverless functions at 60s. The
// original "do everything in one call" flow (fetch news + lens + 3 writers +
// save + push) couldn't fit. It would TIMEOUT (504 / FUNCTION_INVOCATION_TIMEOUT),
// which the admin page would then fail to parse as JSON. So we split:
//
//   mode='fetch' — fetch news (parallel sections) + synthesise lens, save raw
//                  to 3 'pending' brief rows. ~35-45s, fits in 60s.
//   mode='write' — needs `edition`. Read raw_stories from today's pending row,
//                  write that one edition, save as 'ready'. ~15-30s.
//   mode='push'  — send OneSignal push using today's top ready headline.
//   mode='full'  — LEGACY single-call flow. Kept only for emergencies on light
//                  news days; will timeout on busy days. Do not use from cron.
//
// Default when no mode is provided: 'fetch'. This makes the admin page and
// cron sensible: hit the endpoint with no body, you get the fetch phase,
// then chain writes from the caller.

// ─── Per-edition writer pipeline ────────────────────────────────────────────
//
// Pure function: takes raw stories, returns a saved result. Shared by 'write'
// mode and 'full' mode below.

// ============================================================================
// SECTION 21:  CONTENT HYGIENE: LIVENESS, CROSS-SECTION DEDUP & SANITIZE
// ----------------------------------------------------------------------------
// Pre-orchestration hygiene helpers: dead-link detection/drop, cross-section
// dedup of the daily edition, synthetic-chart detection, and signature/edition
// sanitisation. (EditionOutcome, the runWriterForEdition result type, is here.)
// Fns:   isUrlDead, dropDeadLinkStories, dedupeDailyAcrossSections, sanitizeEditionContent
// Flags: URL_LIVENESS
// ============================================================================
export type EditionOutcome = {
  status: 'ready' | 'fallback' | 'failed';
  reason?: string;
  content?: BriefContent;
};

// ─── Sprint 13: URL liveness check ──────────────────────────────────────────
//
// Perplexity occasionally returns formulaic article URLs that 404. Before
// saving content, HEAD-check every story URL and drop stories whose links
// are definitively dead. CONSERVATIVE by design: only 404/410 count as dead.
// 403/405/timeouts/network errors are assumed ALIVE — many publishers block
// bot HEAD requests, and a false drop costs a real story. Set URL_LIVENESS=off
// in Vercel env to disable entirely. Adds ~3-6s to each write.

export const URL_LIVENESS_ENABLED = (process.env.URL_LIVENESS || 'on').toLowerCase() !== 'off';

// Browser-like headers: many publishers return 404/403 to headerless
// datacenter requests (bot mitigation). Without these, real articles can
// test "dead" — see the 2026-06-12 midday incident (28/34 URLs dropped).
export const LIVENESS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
};

export async function isUrlDead(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    let resp = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: LIVENESS_HEADERS });
    if (resp.status === 405 || resp.status === 501 || resp.status === 404 || resp.status === 410) {
      // HEAD blocked OR HEAD says dead — confirm with a tiny ranged GET.
      // Some servers 404 HEAD requests but serve GET fine.
      resp = await fetch(url, {
        method: 'GET', redirect: 'follow', signal: ctrl.signal,
        headers: { ...LIVENESS_HEADERS, Range: 'bytes=0-1024' },
      });
    }
    clearTimeout(timer);
    return resp.status === 404 || resp.status === 410;
  } catch {
    return false; // network error / timeout → assume alive
  }
}

export const LIVENESS_SECTIONS: Record<string, string[]> = {
  '5min':  ['major_events', 'world', 'india', 'topics'],
  '10min': ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture', 'politics', 'markets_news'],
  // deep has no per-story source_urls in the same shape — skipped.
};

// Per-edition output schema for the writer diagnostic (Sprint 19 fix). The
// writer's output shape differs by edition, so the first cut — which counted the
// output against the raw INPUT section keys — logged false zeros for the
// editions whose output is NOT section-aligned: `deep` emits
// long_read/three_patterns/watching_this_week/signature, and `5min` folds
// business/technology/climate_health/sport/culture into a single `topics` array.
// Reporting each edition against the keys it actually emits keeps the log honest.
export const WRITER_DIAG_SECTIONS: Record<string, string[]> = {
  '5min':  ['major_events', 'world', 'india', 'topics'],
  '10min': ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture', 'politics', 'markets_news'],
  'deep':  ['three_patterns', 'watching_this_week'],
};

export async function dropDeadLinkStories(
  content: any,
  edition: Edition,
): Promise<{ content: any; dropped: number }> {
  const sections = LIVENESS_SECTIONS[edition];
  if (!URL_LIVENESS_ENABLED || !sections) return { content, dropped: 0 };

  const urls = new Set<string>();
  for (const sec of sections) {
    for (const s of (content?.[sec] || [])) if (s?.source_url) urls.add(s.source_url);
  }
  const urlList = Array.from(urls);
  if (urlList.length === 0) return { content, dropped: 0 };

  const dead = new Set<string>();
  let cursor = 0;
  const POOL = 8;
  await Promise.all(
    Array.from({ length: Math.min(POOL, urlList.length) }, async () => {
      while (cursor < urlList.length) {
        const u = urlList[cursor++];
        if (await isUrlDead(u)) dead.add(u);
      }
    }),
  );
  if (dead.size === 0) return { content, dropped: 0 };

  // CIRCUIT BREAKER (2026-06-12 incident): if more than 30% of a brief's
  // URLs test dead, something systemic is wrong — either the checker is
  // being bot-blocked, or the fetch fabricated most of its URLs. Dropping
  // them would gut the brief (Daily went to 3 stories, score 63→38).
  // Fail OPEN: drop nothing, log loudly, ship the brief intact. The log
  // line reveals which failure mode it was so it can be fixed at the
  // fetch-prompt level rather than by hollowing out the product.
  const deadShare = dead.size / urlList.length;
  if (deadShare > 0.3) {
    console.error(`[liveness] CIRCUIT BREAKER: ${dead.size}/${urlList.length} URLs (${Math.round(deadShare * 100)}%) tested dead for ${edition} — refusing to drop anything. Either the checker is blocked or the fetch hallucinated URLs. Sample: ${Array.from(dead).slice(0, 3).join(' , ')}`);
    return { content, dropped: 0 };
  }

  let dropped = 0;
  const out: any = { ...content };
  for (const sec of sections) {
    const before = (out[sec] || []).length;
    out[sec] = (out[sec] || []).filter((s: any) => !dead.has(s.source_url));
    dropped += before - out[sec].length;
  }
  for (const u of Array.from(dead)) console.log(`[liveness] dead link dropped: ${u}`);
  return { content: out, dropped };
}

// ─── Sprint 14.4: deterministic editorial guardrails ────────────────────────
// These run AFTER the writer, BEFORE save. The writer prompts already ask for
// the right behaviour, but gpt-4o / gpt-4o-mini occasionally ignore it — the
// 06-14 deep brief shipped a fabricated chart (values 150/200/250/300/350,
// labelled into 2027-2028) and a quote attributed to "Independent Commentary",
// and the 10min ran the same Anthropic story in three sections. We enforce the
// trust-critical rules in code rather than hope the model complies.

// normaliseUrlForCompare -> @/lib/generate-brief/utils

export const DAILY_SECTION_PRIORITY = [
  'major_events', 'india', 'world', 'business', 'politics',
  'markets_news', 'technology', 'climate_health', 'sport', 'culture',
];

// Remove the same story (by URL) appearing in multiple sections. CONSERVATIVE:
// a duplicate is only dropped from a lower-priority section when that section
// keeps at least one story afterwards. We never blank a section — that would
// both hide content and (perversely) trigger the scorer's empty-section
// penalty. On thin days this is a no-op; on rich days it kills the triple-list.
export function dedupeDailyAcrossSections(content: any): { content: any; dropped: number } {
  if (!content || typeof content !== 'object') return { content, dropped: 0 };
  const seen = new Set<string>();
  let dropped = 0;
  for (const sec of DAILY_SECTION_PRIORITY) {
    // OVERLAY: the front page is a highlight layer that intentionally repeats a
    // few topical leads — don't dedup it against the sections (that would delete
    // the overlay), and don't let it consume URLs the topical copies need.
    if (PLACEMENT_V2 && PLACEMENT_OVERLAY && sec === 'major_events') continue;
    const arr = content[sec];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const uniques: any[] = [];
    const dups: any[] = [];
    for (const story of arr) {
      const key = normaliseUrlForCompare(story?.source_url);
      if (key && seen.has(key)) dups.push(story);
      else uniques.push(story);
    }
    let kept: any[];
    if (uniques.length > 0) {
      kept = uniques;
      dropped += dups.length;
    } else {
      // Every story here duplicates a higher-priority section. Keep one so the
      // section isn't blanked; drop the rest.
      kept = arr.slice(0, 1);
      dropped += arr.length - 1;
    }
    for (const story of kept) {
      const key = normaliseUrlForCompare(story?.source_url);
      if (key) seen.add(key);
    }
    content[sec] = kept;
  }
  return { content, dropped };
}

// Attribution strings that aren't real attributions. A quote pinned to any of
// these (or to nothing) is dropped — better no quote than a fabricated one.
export const GENERIC_ATTRIBUTIONS = new Set([
  'independent commentary', 'commentary', 'analyst', 'analysts', 'an analyst',
  'expert', 'experts', 'an expert', 'observer', 'observers', 'industry observer',
  'industry observers', 'industry sources', 'sources', 'a source', 'spokesperson',
  'a spokesperson', 'editorial', 'staff', 'correspondent', 'our correspondent',
  'unknown', 'n/a', 'na', 'anonymous', 'official', 'officials',
]);

// A chart's data is treated as synthetic (and dropped) when it can't be drawn
// from real numbers: too few points, any label projecting a future year, or a
// suspiciously perfect arithmetic sequence (the textbook hallucination shape,
// e.g. 150/200/250/300/350).
export function looksSyntheticChart(dp: any[]): boolean {
  const pts = (dp || []).filter((p) => p && typeof p.value === 'number' && isFinite(p.value));
  if (pts.length < 2) return true;
  const year = new Date().getFullYear();
  for (const p of pts) {
    const yr = parseInt(String(p.label ?? ''), 10);
    if (!isNaN(yr) && yr > 1900 && yr > year) return true;
  }
  if (pts.length >= 4) {
    const deltas: number[] = [];
    for (let i = 1; i < pts.length; i++) deltas.push(pts[i].value - pts[i - 1].value);
    const allEqual = deltas.every((d) => Math.abs(d - deltas[0]) < 1e-9);
    if (allEqual && Math.abs(deltas[0]) > 0) return true;
  }
  return false;
}

export function sanitizeSignature(sig: any): { sig: any; notes: string[] } {
  const notes: string[] = [];
  if (!sig || typeof sig !== 'object') return { sig, notes };
  if (sig.one_chart) {
    const dp = Array.isArray(sig.one_chart.data_points) ? sig.one_chart.data_points : [];
    if (dp.length === 0 || looksSyntheticChart(dp)) {
      sig.one_chart = null;
      notes.push('dropped one_chart (no real/usable data points)');
    }
  }
  if (sig.one_quote) {
    const attr = String(sig.one_quote.attribution || '').trim();
    const quote = String(sig.one_quote.quote || '').trim();
    const generic = !attr || GENERIC_ATTRIBUTIONS.has(attr.toLowerCase()) || !/[a-z]/i.test(attr);
    if (!quote || generic) {
      sig.one_quote = null;
      notes.push('dropped one_quote (missing or unattributed)');
    }
  }
  return { sig, notes };
}

// Per-edition post-write cleanup. Dispatches the guardrails relevant to each
// edition. Pure/deterministic — safe to run on every successful write.
export function sanitizeEditionContent(ed: Edition, content: any): any {
  if (!content || typeof content !== 'object') return content;
  if (ed === '10min') {
    const { content: deduped, dropped } = dedupeDailyAcrossSections(content);
    if (dropped > 0) console.log(`[10min] cross-section dedupe removed ${dropped} duplicate listing(s).`);
    return deduped;
  }
  if (ed === 'deep') {
    const { sig, notes } = sanitizeSignature(content.signature);
    content.signature = sig;
    if (notes.length) console.log(`[deep] signature guardrails: ${notes.join('; ')}.`);
    return content;
  }
  return content;
}

// ============================================================================
// SECTION 22:  WRITER ORCHESTRATION  (runWriterForEdition)
// ----------------------------------------------------------------------------
// Per-edition conductor: write -> repair -> coherence drop (+ backfill guard)
// -> backfill -> dead-link drop -> validate -> invariant check -> outcome.
// This is where Sections 16-21 are wired together in order.
// Fns:   runWriterForEdition
// Flags: (orchestrates Sections 16-21 flags)
// ============================================================================
export async function runWriterForEdition(
  ed: Edition,
  rawStories: RawStories,
  lens: any | null,
): Promise<EditionOutcome> {
  const writer =
    ed === '5min'  ? writeQuickEdition
  : ed === '10min' ? writeDailyEdition
  :                  writeEditorialEdition;

  // Per Sprint 9 spec: 5min capped at 15, 10min at 20. Sprint 20 Drop #4 raises
  // the 5-min shared provisioning to 20 (flag FIVE_MIN_FILL, default on; 'off'
  // restores 15) so the personalised 5-min edition can fill to its 20-story cap
  // instead of shipping thin (~13/20). Both are deterministic code subsets.
  const FIVE_MIN_FILL = (process.env.FIVE_MIN_FILL || 'on').toLowerCase() !== 'off';
  const writerInput =
    ed === '5min'  ? buildSubset(rawStories, FIVE_MIN_FILL ? 20 : 15)
  : ed === '10min' ? buildSubset(rawStories, 20)
  :                  rawStories;

  // Two attempts. gpt-4o-mini occasionally returns non-JSON or drops required
  // fields; one retry catches most of these. We only fall back to yesterday's
  // brief if BOTH attempts fail.
  let lastError: string = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`Writing ${ed}${attempt === 2 ? ' (retry)' : ''}...`);
      const content = await writer(writerInput);
      // Writer diagnostic (Sprint 18.3): what the model actually returned per
      // section BEFORE any repair or top-up backfill. This is how we confirm the
      // canned-"why it matters" symptom at its source — e.g. "major_events 1/5"
      // means the writer under-produced and the rest is raw-template padding.
      try {
        // Count the writer's output against the keys THIS edition actually emits
        // (Sprint 19 schema fix). Where an output key aligns with an input
        // section we show written/supplied; keys with no matching input array
        // (5min `topics`, deep's long-form arrays) show the written count only —
        // no more false `0/N` zeros for deep and the folded 5min sections.
        const diagKeys = WRITER_DIAG_SECTIONS[ed] || [];
        const counts = diagKeys
          .map((sec) => {
            const wrote = Array.isArray((content as any)?.[sec]) ? (content as any)[sec].length : 0;
            const supplied = (writerInput as any)?.[sec];
            return Array.isArray(supplied) ? `${sec} ${wrote}/${supplied.length}` : `${sec} ${wrote}`;
          })
          .join(' · ');
        console.log(`[writer] ${ed} returned (written/supplied): ${counts}`);
      } catch (e) { /* diagnostic only — never break the run */ }
      const repaired = repairCommonOmissions(content, ed, writerInput);
      const validation = validateBrief(repaired, ed);
      if (validation.ok) {
        // Post-write source-URL guard: drop any story whose source_url isn't
        // from a Tier-1 whitelisted publisher (catches writer hallucinations).
        let { content: stripped, dropped } = stripNonWhitelistedFromContent(validation.data, ed);
        if (dropped > 0) {
          console.log(`[${ed}] Post-write strip removed ${dropped} non-whitelisted stories.`);
          // Sprint 14.8 — top the stripped sections back up to the subset counts
          // (the real fix for "only 2 India items"). Re-validate; keep the
          // top-up only if it still passes Zod, so it can never ship bad content.
          const candidate = JSON.parse(JSON.stringify(stripped));
          const added = backfillToSubsetCounts(candidate, ed, writerInput);
          if (added > 0) {
            const reval = validateBrief(candidate, ed);
            if (reval.ok) {
              stripped = reval.data;
              console.log(`[${ed}] strip backfill restored ${added} story(ies) to subset counts.`);
            } else {
              console.warn(`[${ed}] strip backfill invalid; keeping stripped brief — ${reval.errors}`);
            }
          }
        }
        // Sprint 13: drop stories whose source_url is definitively dead (404/410).
        const live = await dropDeadLinkStories(stripped, ed);
        if (live.dropped > 0) {
          console.log(`[${ed}] URL liveness dropped ${live.dropped} dead-linked stories.`);
        }
        // Sprint 14.4: deterministic editorial guardrails (dedupe / signature)
        // run here — after validation/strip/liveness, before save — so they
        // apply to exactly the content the reader will see.
        let finalContent = sanitizeEditionContent(ed, live.content);
        // Sprint 14.5/14.8: copy-desk QA on the editions where contradiction /
        // synthesis risk is highest. BLOCKING (founder decision): high-severity
        // contradictions/fabrications are dropped, then we re-validate and top
        // up so a drop can't leave a section short or the brief invalid. Gated
        // by COHERENCE_ENFORCE ('off' reverts to log-only).
        if (ed === '10min' || ed === 'deep') {
          try {
            const issues = await runCoherenceCheck(ed, finalContent);
            if (COHERENCE_ENFORCE && issues.length > 0) {
              const candidate = JSON.parse(JSON.stringify(finalContent));
              const dropRes = applyCoherenceDrops(
                candidate, ed, issues,
                COHERENCE_BACKFILL_GUARD ? { guard: true, subset: writerInput } : undefined,
              );
              const removed = dropRes.removed;
              if (removed > 0) {
                // F1: bar the just-dropped stories from being re-added by backfill.
                backfillToSubsetCounts(
                  candidate, ed, writerInput,
                  COHERENCE_BACKFILL_GUARD ? dropRes.droppedUrlKeys : undefined,
                );
                const reval = validateBrief(candidate, ed);
                if (reval.ok) {
                  finalContent = reval.data;
                  console.log(`[${ed}] coherence enforcement removed ${removed} story(ies); brief re-validated.`);
                } else {
                  console.warn(`[${ed}] coherence-enforced brief invalid; shipping pre-enforcement content — ${reval.errors}`);
                }
              }
            }
          } catch (e: any) { console.warn(`[${ed}] coherence check skipped: ${e?.message || e}`); }
        }
        // Save the FULL rawStories (not the subset) into the brief row so
        // downstream consumers see the same raw for every edition.
        // Sprint 19 — replace any backfill template "why it matters" with real,
        // story-specific analysis before saving, so padded stories never render
        // as canned boilerplate (the Sprint 18 regression). Catches every
        // backfill path (empty-section, post-strip top-up, post-coherence top-up).
        await rewriteTemplateWhys(finalContent, ed);
        // Sprint 26 (F7) / 27.1 — final invariant check on the exact object being
        // saved; the full pool rides along so the curated-lead delivery report
        // can recognise cut leads that never made the subset.
        if (BRIEF_INVARIANTS) {
          const inv = checkBriefInvariants(finalContent, writerInput, ed, rawStories);
          if (!inv.ok && inv.halted && BRIEF_INVARIANTS_HALT) {
            throw new Error(`INVARIANTS_HALT: ${ed} — ${inv.violations.join(' | ')}`);
          }
        }
        // Sprint 27.1 (N6) — SHIPPED census on the exact object being saved.
        // The 07-05 run's writer diagnostic said "politics 5/5" while liveness
        // had dropped a fabricated URL and 4 shipped — written≠shipped was
        // invisible. This line is the shipped truth the RCA should reconcile
        // against the writer line.
        try {
          const shippedKeys = (WRITER_DIAG_SECTIONS[ed] || []).filter((k) => Array.isArray((finalContent as any)?.[k]));
          const parts = shippedKeys.map((k) => `${k} ${(finalContent as any)[k].length}`);
          const totalShipped = shippedKeys.reduce((n, k) => n + (finalContent as any)[k].length, 0);
          console.log(`[write:${ed}] shipped — ${parts.join(' · ')} · total ${totalShipped}`);
        } catch (e) { /* diagnostic only */ }
        await saveBriefToSupabase(ed, rawStories, finalContent, lens, 'ready');
        return { status: 'ready', content: finalContent };
      }
      // Narrowed: validation is the failure branch here.
      const errMsg = (validation as { ok: false; errors: string }).errors;
      lastError = errMsg;
      console.warn(`[${ed}] Attempt ${attempt} validation failed: ${errMsg}`);
    } catch (err: any) {
      lastError = err.message;
      console.warn(`[${ed}] Attempt ${attempt} threw: ${err.message}`);
      // Sprint 20.1 — callOpenAIChat now does its own bounded 429 backoff. A
      // tagged RATE_LIMITED error means the token window did not clear within the
      // function budget; an immediate second attempt would only fail again and
      // risk the 60s cap, so stop and fall back cleanly.
      if (typeof err?.message === 'string' && err.message.startsWith('RATE_LIMITED')) {
        console.warn(`[${ed}] rate limit persisted past in-call backoff — skipping redundant retry, using fallback.`);
        break;
      }
      // Sprint 26 (F7) — a halt-class invariant violation means the brief we
      // built is unshippable; a retry would likely reproduce it, so go straight
      // to the previous-good-brief fallback instead of burning the second attempt.
      if (typeof err?.message === 'string' && err.message.startsWith('INVARIANTS_HALT')) {
        console.error(`[${ed}] HALTED by final invariant checker — not shipping this brief; falling back to the previous good brief. ${err.message}`);
        break;
      }
    }
  }

  // Both attempts failed — fall back to yesterday's brief, but only if
  // yesterday's brief is itself fresh (status='ready'). If yesterday was
  // already a fallback, we'd be inheriting stale content from days ago — stop
  // the chain and mark today 'failed' so the UI shows "no fresh brief today"
  // instead of week-old stories.
  console.error(`[${ed}] Both attempts failed. Last error: ${lastError}`);
  const prev = await fetchPreviousBrief(ed);
  if (prev && prev.status === 'ready') {
    await saveBriefToSupabase(ed, rawStories, prev.content, prev.lens, 'fallback');
    return { status: 'fallback', reason: lastError, content: prev.content };
  }
  if (prev && prev.status !== 'ready') {
    console.warn(`[${ed}] Previous brief was status=${prev.status}, not 'ready'. Refusing to chain-fallback; marking today as failed.`);
  }
  await saveBriefToSupabase(ed, rawStories, null, lens, 'failed');
  return { status: 'failed', reason: lastError };
}

// ─── Mode: fetch ────────────────────────────────────────────────────────────
//
// Phase 1 of the daily flow. Loads personalisation universe, fetches news +
// lens from OpenAI, saves raw_stories to three pending brief rows (one per
// edition). Lens lives inside raw_stories.lens — the writers read it from
// there in the write phase.

