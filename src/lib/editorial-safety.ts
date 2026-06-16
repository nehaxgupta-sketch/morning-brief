// src/lib/editorial-safety.ts
//
// Sprint 14.5 — editorial sensitivity for the "your city" section.
// Sprint 14.7 — broadened lexicon + graded severity tiers, and re-positioned
//                as a DETERMINISTIC BACKSTOP.
//
// As of Sprint 14.7 the primary sensitivity judgment is made by Claude inside
// personalise-briefs.tsx (it reads meaning, so it catches plain phrasings like
// "14-year-old dies in accident" that a regex misses — which is exactly what
// slipped through before). This module remains as a cheap, deterministic
// safety net that runs AFTER Claude (and is the sole guard if Claude is
// unavailable).
//
// Policy (matches the product's editorial line):
//   - This does NOT censor news. A significant local story that involves crime
//     or tragedy still appears — "if tragedy is what happened, tragedy is what
//     we show."
//   - It only ensures crime/tragedy never LEADS or DOMINATES a small local
//     section: such items are demoted below civic news and capped to one.
//   - If a city's only available items are sensitive (a quiet day in a small
//     city), they are kept rather than blanking the section.
//   - When more than one sensitive item competes for the single trailing slot,
//     the LEAST severe is kept (so a forced-include is the gentlest one, never
//     a child death / suicide / sexual-violence story).

// ─── Lexicons (by severity) ─────────────────────────────────────────────────

// Tier 3 — most sensitive: self-harm, sexual violence, harm to minors.
const SELF_HARM_RE = /\b(suicid\w*|self[-\s]?harm|killed (?:himself|herself|themselves)|took (?:his|her|their) (?:own )?life)\b/i;
const SEXUAL_RE = /\b(rape\w*|gang[-\s]?rape|sexual assault|sexually assault\w*|molest\w*|sexual abuse|child abuse|pocso)\b/i;
const CHILD_RE = /\b(minor|child|children|toddler|infant|baby|schoolboy|schoolgirl|\d{1,2}[-\s]?year[-\s]?old|teenager|teen)\b/i;

// Tier 2 — fatalities and graphic violent crime.
const FATALITY_RE = /\b(dies|died|dead|death|deaths|killed|fatal\w*|drown\w*|electrocut\w*|burnt to death|charred|succumb\w*)\b/i;
const GRAPHIC_CRIME_RE = /\b(murder\w*|stabb\w*|hacked to death|dismember\w*|mutilat\w*|behead\w*|acid attack|brutal\w* (?:killed|attack)|lynch\w*)\b/i;

// Tier 1 — general crime, accidents, disasters.
const CRIME_RE = /\b(arrest\w*|abscond\w*|bust\w*|raid\w*|gang|weapon\w*|arms|firearm\w*|smuggl\w*|kidnap\w*|abduct\w*|robber\w*|robbed|loot\w*|extort\w*|shoot\w*|shot dead|riot\w*|clash\w*|assault\w*)\b/i;
const ACCIDENT_RE = /\b(accident\w*|crash\w*|collision|collide\w*|derail\w*|blast\w*|explosion|explod\w*|fire|blaze|stampede|building collapse|collaps\w*|mishap)\b/i;

// Severity tier: 0 = not sensitive, 1 = crime/accident, 2 = fatality/graphic,
// 3 = self-harm / sexual violence / harm to a minor. Higher = more sensitive.
export function sensitivityTier(headline?: string, body?: string): number {
  const txt = `${headline || ''} ${body || ''}`;

  // Tier 3 first.
  if (SELF_HARM_RE.test(txt) || SEXUAL_RE.test(txt)) return 3;
  const harmContext = FATALITY_RE.test(txt) || GRAPHIC_CRIME_RE.test(txt) || CRIME_RE.test(txt) || ACCIDENT_RE.test(txt);
  if (CHILD_RE.test(txt) && harmContext) return 3; // e.g. "14-year-old dies in accident"

  // Tier 2.
  if (FATALITY_RE.test(txt) || GRAPHIC_CRIME_RE.test(txt)) return 2;

  // Tier 1.
  if (CRIME_RE.test(txt) || ACCIDENT_RE.test(txt)) return 1;

  return 0;
}

export function isSensitiveHeadline(headline?: string, body?: string): boolean {
  return sensitivityTier(headline, body) > 0;
}

// Reorder city stories so crime/tragedy never leads and at most one such item
// trails. Civic/normal stories keep their order and come first. If everything
// is sensitive, return as-is (better some local content than a blank section).
// When capping, keep the LEAST severe sensitive item.
export function applyCitySafety<T extends { headline?: string; body?: string }>(stories: T[]): T[] {
  if (!Array.isArray(stories) || stories.length === 0) return stories;

  const normal: T[] = [];
  const sensitive: { item: T; tier: number; idx: number }[] = [];

  stories.forEach((s, idx) => {
    const tier = sensitivityTier(s?.headline, s?.body);
    if (tier === 0) normal.push(s);
    else sensitive.push({ item: s, tier, idx });
  });

  // Nothing civic to lead with → keep everything, original order (don't blank).
  if (normal.length === 0) return stories.slice();

  // Demote sensitive below civic; keep only the least-severe one (stable on ties).
  sensitive.sort((a, b) => (a.tier - b.tier) || (a.idx - b.idx));
  const trailing = sensitive.slice(0, 1).map((s) => s.item);

  return [...normal, ...trailing];
}
