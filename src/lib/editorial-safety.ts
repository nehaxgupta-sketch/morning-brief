// src/lib/editorial-safety.ts
//
// Sprint 14.5 — editorial sensitivity for the "your city" tail.
//
// The 14.4 audit found a personalised city section led with an individual's
// suicide and another with a murder, both surfaced as bare items with light
// "local news worth knowing" framing. That reads as tone-deaf in a calm,
// premium brief.
//
// This does NOT censor news: a significant local story that happens to involve
// crime or tragedy still appears. It only prevents crime/tragedy from LEADING
// or DOMINATING a small local section — such items are moved to the end and
// capped. And if a city's only available items are sensitive (e.g. a slow news
// day in a small city), we leave them rather than blank the section.

const SELF_HARM_RE = /\b(suicid\w*|self[-\s]?harm|killed (?:himself|herself|themselves)|took (?:his|her|their) (?:own )?life)\b/i;
const GRAPHIC_CRIME_RE = /\b(murder\w*|rape\w*|gang[-\s]?rape|sexual assault|stabb\w*|hacked to death|dismember\w*|mutilat\w*|behead\w*|acid attack|molest\w*|brutal\w* (?:killed|attack))\b/i;

export function isSensitiveHeadline(headline?: string, body?: string): boolean {
  const txt = `${headline || ''} ${body || ''}`;
  return SELF_HARM_RE.test(txt) || GRAPHIC_CRIME_RE.test(txt);
}

// Reorder city stories so crime/tragedy never leads and at most one such item
// trails. If everything is sensitive, return as-is (better some local content
// than a blank section).
export function applyCitySafety<T extends { headline?: string; body?: string }>(stories: T[]): T[] {
  if (!Array.isArray(stories) || stories.length === 0) return stories;
  const normal: T[] = [];
  const sensitive: T[] = [];
  for (const s of stories) {
    if (isSensitiveHeadline(s?.headline, s?.body)) sensitive.push(s);
    else normal.push(s);
  }
  if (normal.length === 0) return stories.slice();
  return [...normal, ...sensitive.slice(0, 1)];
}
