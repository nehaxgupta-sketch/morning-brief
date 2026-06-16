// src/lib/saved.ts
//
// Sprint 14.6 — saved-stories data layer. Client-side reads/writes under RLS
// (same pattern as desk_subscriptions / storyline_follows — no API hop). A
// story is keyed by source_url. Used by the brief reader (save toggle) and the
// Stories tab (Saved list).

import { supabase } from '@/lib/supabase';

export type SavedStory = {
  id: number;
  user_id: string;
  source_url: string;
  headline: string | null;
  source: string | null;
  section: string | null;
  saved_at: string;
};

// Just the URLs — used by the reader to mark which stories are already saved.
export async function listSavedUrls(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('saved_stories')
    .select('source_url')
    .eq('user_id', userId);
  if (error) { console.warn('[saved] listSavedUrls failed:', error.message); return []; }
  return (data || []).map((r: any) => r.source_url).filter(Boolean);
}

// Full rows, newest first — used by the Saved list.
export async function listSavedStories(userId: string): Promise<SavedStory[]> {
  const { data, error } = await supabase
    .from('saved_stories')
    .select('*')
    .eq('user_id', userId)
    .order('saved_at', { ascending: false });
  if (error) { console.warn('[saved] listSavedStories failed:', error.message); return []; }
  return (data || []) as SavedStory[];
}

export async function saveStory(
  userId: string,
  story: { source_url: string; headline?: string; source?: string; section?: string },
): Promise<{ error?: string }> {
  if (!story?.source_url) return { error: 'Story has no source_url' };
  const { error } = await supabase.from('saved_stories').insert({
    user_id: userId,
    source_url: story.source_url,
    headline: story.headline || null,
    source: story.source || null,
    section: story.section || null,
  });
  // Duplicate (already saved) is not an error worth surfacing.
  if (error && !String(error.message || '').toLowerCase().includes('duplicate')) {
    return { error: error.message };
  }
  return {};
}

export async function unsaveStory(userId: string, sourceUrl: string): Promise<{ error?: string }> {
  if (!sourceUrl) return { error: 'No source_url' };
  const { error } = await supabase
    .from('saved_stories')
    .delete()
    .eq('user_id', userId)
    .eq('source_url', sourceUrl);
  return error ? { error: error.message } : {};
}
