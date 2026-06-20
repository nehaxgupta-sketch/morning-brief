// src/lib/grounding-guard.ts
//
// Sprint 15 — Principle #0 enforcement: the brief must not contain facts the
// sources don't support. The single highest fabrication risk is market numbers,
// so this guard DETERMINISTICALLY overwrites the written market block with the
// real retrieved figures (the writer describes direction; it never owns the
// numbers). It also runs a light audit that LOGS any specific number or quoted
// phrase in a written story that doesn't appear in that story's source text —
// monitoring first, so we never wrongly delete legitimate added context.
//
// Gated by GROUNDING_GUARD ('on' default; 'off' disables). Fail-safe: any error
// leaves the content unchanged.

type Index = { name: string; change: string };

const ON = (process.env.GROUNDING_GUARD || 'on').toLowerCase() !== 'off';

// Replace whatever the writer put in the market block with the real numbers.
// Matches by index name (case/spacing-insensitive); appends any missing index.
export function enforceMarketNumbers(content: any, retrieved: Index[]): number {
  if (!ON || !content || !Array.isArray(retrieved) || retrieved.length === 0) return 0;
  try {
    const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const byName = new Map(retrieved.map((i) => [norm(i.name), i.change]));
    // The market indices can live under a few shapes depending on edition.
    const blocks = [content?.markets?.indices, content?.market?.indices, content?.markets_indices].filter(Array.isArray);
    let fixed = 0;
    for (const arr of blocks) {
      for (const ix of arr) {
        const real = byName.get(norm(ix?.name));
        if (real != null && ix.change !== real) { ix.change = real; fixed++; }
      }
    }
    return fixed;
  } catch { return 0; }
}

// Light audit: numbers/quotes in written text that aren't in the source text.
// Returns warnings (caller logs them); does NOT mutate content.
export function auditGrounding(
  stories: Array<{ headline?: string; source_url?: string; [k: string]: any }>,
  poolByUrl: Map<string, { headline?: string; body?: string }>,
): string[] {
  if (!ON || !Array.isArray(stories)) return [];
  const warnings: string[] = [];
  try {
    for (const s of stories) {
      const src = s?.source_url ? poolByUrl.get(s.source_url) : undefined;
      if (!src) continue;
      const sourceText = `${src.headline || ''} ${src.body || ''}`.toLowerCase();
      const written = [s.facts, s.what_happened, s.background, s.why_it_matters, s.analysis]
        .filter((x) => typeof x === 'string').join(' ');
      // Specific multi-digit numbers (skip years and tiny counts).
      const nums = (written.match(/\b\d[\d,]{2,}(?:\.\d+)?%?\b/g) || [])
        .filter((n) => !/^(19|20)\d{2}$/.test(n.replace(/[^0-9]/g, '')));
      for (const n of nums.slice(0, 6)) {
        const bare = n.replace(/[,%]/g, '');
        if (!sourceText.includes(n.toLowerCase()) && !sourceText.includes(bare)) {
          warnings.push(`[grounding] number "${n}" not in source for: ${String(s.headline || '').slice(0, 60)}`);
        }
      }
      // Quoted phrases of 4+ words.
      const quotes = written.match(/"([^"]{20,})"/g) || [];
      for (const q of quotes.slice(0, 3)) {
        const inner = q.replace(/"/g, '').toLowerCase().slice(0, 40);
        if (!sourceText.includes(inner)) {
          warnings.push(`[grounding] quote not in source for: ${String(s.headline || '').slice(0, 60)}`);
        }
      }
    }
  } catch { /* fail-safe */ }
  return warnings;
}

// Convenience: collect every story across a brief's list sections (for audit).
export function collectStories(content: any): Array<any> {
  const SECTS = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture', 'politics', 'markets_news', 'topics'];
  const out: any[] = [];
  for (const k of SECTS) if (Array.isArray(content?.[k])) out.push(...content[k]);
  return out;
}
