// src/lib/brief/assemble.ts  —  STEP 6: project to the edition view (render-ready)
//
// Depth-projects the routed Articles: 5-min = headline + hook; 10-min = the full
// Article; deep = 10-min body for now (cross-article synthesis lands with the
// deep step). Attaches each personalised section's WIM. Persistence is a thin
// follow-up once we like this shape (see run.ts / the note in chat).

import type { Article, Edition, EditionBrief, EditionSection, EditionStory, StepAssemble } from './types';

// lens (home flash card) threads through when we wire the home card; empty for now.
const EMPTY_LENS = { world: '', india: '', markets: '', watch: '' };

function project(a: Article, edition: Edition): EditionStory {
  const base: EditionStory = { eventId: a.eventId, headline: a.headline, source: a.source, source_url: a.source_url };
  if (edition === '5min') return { ...base, hook: a.hook };
  return {
    ...base, hook: a.hook,
    facts: a.facts, background: a.background, what_happens_next: a.what_happens_next, analysis: a.analysis,
  };
}

export const assembleBrief: StepAssemble = (routed, store): EditionBrief => {
  const sections: EditionSection[] = routed.sections.map((sec) => ({
    key: sec.key,
    label: sec.label,
    kind: sec.kind,
    stories: sec.eventIds.map((id) => store.byEventId[id]).filter(Boolean).map((a) => project(a, routed.edition)),
    why_it_matters: sec.kind !== 'core' ? routed.wim[sec.key] : undefined,
  }));

  return {
    userId: routed.userId,
    date: routed.date,
    edition: routed.edition,
    sections,
    markets: store.markets,
    lens: EMPTY_LENS,
  };
};
