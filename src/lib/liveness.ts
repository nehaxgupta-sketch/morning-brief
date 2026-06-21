// src/lib/liveness.ts
//
// Sprint 17 — shared URL liveness check. Extracted (generalised) from the proven
// Sprint-13 implementation in generate-brief.tsx so EVERY surface that ships
// story URLs uses one verified, hardened implementation instead of its own copy:
//   - generate-brief.tsx  (the three brief editions — already has inline equiv.)
//   - personalise-briefs.tsx  (personal_sections — currently UNGUARDED; this is
//                              where the dead cntraveller link slipped through)
//   - generate-desks.tsx  (desk features already verify; pool stories could too)
//
// Design (unchanged from the original, by deliberate caution):
//   - HEAD first; if HEAD is blocked (405/501) or says 404/410, confirm with a
//     tiny ranged GET (some servers 404 HEAD but serve GET fine).
//   - ONLY 404/410 count as dead. 403/timeouts/network errors → assume ALIVE
//     (publishers bot-block datacenter IPs; a false drop costs a real story).
//   - Browser-like headers (the 2026-06-12 incident: headerless requests made
//     28/34 real URLs test "dead").
//   - 30% CIRCUIT BREAKER, fail-OPEN: if more than a third of a batch tests dead,
//     the checker is probably being blocked (or the fetch hallucinated most URLs)
//     — drop nothing, log loudly, ship intact. Better a few dead links than a
//     hollowed-out section.
//
// Toggle with URL_LIVENESS=off (matches the existing env var).

const URL_LIVENESS_ENABLED = (process.env.URL_LIVENESS || 'on').toLowerCase() !== 'off';

const LIVENESS_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
};

/** True only if the URL is DEFINITIVELY dead (404/410). Everything else → alive. */
export async function isUrlDead(url: string, timeoutMs = 3500): Promise<boolean> {
  if (!url || typeof url !== 'string') return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: LIVENESS_HEADERS });
    if (resp.status === 405 || resp.status === 501 || resp.status === 404 || resp.status === 410) {
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

/** Return the subset of `urls` that are definitively dead (concurrency-bounded). */
export async function findDeadUrls(urls: string[], concurrency = 8): Promise<Set<string>> {
  const dead = new Set<string>();
  const list = Array.from(new Set(urls.filter(Boolean)));
  if (!URL_LIVENESS_ENABLED || list.length === 0) return dead;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (cursor < list.length) {
        const u = list[cursor++];
        if (await isUrlDead(u)) dead.add(u);
      }
    }),
  );
  return dead;
}

export interface DropDeadResult<T> {
  kept: T[];
  dead: string[];
  checked: number;
  circuitBroken: boolean;
}

/**
 * Generic dead-link filter over ANY list of story-like objects.
 * `getUrl` extracts each item's URL; structure-agnostic, so it works for brief
 * sections, personal_sections[].stories, desk sections — anything.
 * Honours the 30% circuit breaker (fail-open) and the URL_LIVENESS toggle.
 */
export async function dropDeadStories<T>(
  items: T[],
  getUrl: (item: T) => string | undefined | null,
  opts: { label?: string; concurrency?: number; circuitBreaker?: number } = {},
): Promise<DropDeadResult<T>> {
  const label = opts.label || 'liveness';
  const breaker = opts.circuitBreaker ?? 0.3;
  if (!URL_LIVENESS_ENABLED || !Array.isArray(items) || items.length === 0) {
    return { kept: items || [], dead: [], checked: 0, circuitBroken: false };
  }
  const urls = items.map(getUrl).filter(Boolean) as string[];
  const uniqueUrls = Array.from(new Set(urls));
  if (uniqueUrls.length === 0) return { kept: items, dead: [], checked: 0, circuitBroken: false };

  const dead = await findDeadUrls(uniqueUrls, opts.concurrency ?? 8);
  if (dead.size === 0) return { kept: items, dead: [], checked: uniqueUrls.length, circuitBroken: false };

  const deadShare = dead.size / uniqueUrls.length;
  if (deadShare > breaker) {
    console.error(`[${label}] CIRCUIT BREAKER: ${dead.size}/${uniqueUrls.length} URLs (${Math.round(deadShare * 100)}%) tested dead — refusing to drop anything (checker likely blocked, or the fetch hallucinated URLs). Sample: ${Array.from(dead).slice(0, 3).join(' , ')}`);
    return { kept: items, dead: Array.from(dead), checked: uniqueUrls.length, circuitBroken: true };
  }

  const kept = items.filter((it) => { const u = getUrl(it); return !u || !dead.has(u); });
  for (const u of Array.from(dead)) console.log(`[${label}] dead link dropped: ${u}`);
  return { kept, dead: Array.from(dead), checked: uniqueUrls.length, circuitBroken: false };
}
