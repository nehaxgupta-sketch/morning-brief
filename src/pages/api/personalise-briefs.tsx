import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

// ─── Personalisation overlay ────────────────────────────────────────────────
// For each user with brief_type === 'personalised', this endpoint reorders and
// lightly reframes the day's standard brief based on their profile (city,
// profession, interests, industry). Uses Haiku (cheap, fast).
//
// Trigger: call this AFTER /api/generate-brief has saved the day's standard
// briefs. The cron-job.org schedule can either hit this directly at ~6:50 AM
// IST (5 min after the main brief), or you can chain it manually from the
// main handler later.
//
// IMPORTANT: This endpoint assumes the personalised_briefs table has columns:
//   user_id (uuid), date (date), edition (text), status (text),
//   content (jsonb), generated_at (timestamptz)
// with a unique constraint on (user_id, date, edition).
// If your schema differs, the upsert call will need adjusting.
//
// Cost note: at single-user scale this is trivial (Haiku, ~$0.01/user/day).

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

type Edition = '5min' | '10min' | 'deep';

function getISTDate(offsetDays = 0): string {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().split('T')[0];
}

function extractJsonObject(text: string): any {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found');

  let depth = 0, inString = false, escape = false, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('JSON truncated');
  return JSON.parse(cleaned.slice(start, end + 1));
}

interface UserProfile {
  id: string;
  city_current?: string | null;
  city_home?: string | null;
  profession?: string | null;
  industry?: string | null;
  interests?: string[] | null;
  edition_preference?: string | null;
  mood_preference?: string | null;
  brief_type?: string | null;
}

async function personaliseEdition(
  standardBrief: any,
  edition: Edition,
  profile: UserProfile
): Promise<any> {
  const interests = Array.isArray(profile.interests)
    ? profile.interests.join(', ')
    : (profile.interests || 'general news');

  const prompt = `You are personalising a daily news brief for a specific reader. You are NOT rewriting the brief — you are lightly adjusting it to feel more relevant to this person.

READER PROFILE:
- Currently in: ${profile.city_current || 'India'}
- Home city: ${profile.city_home || 'unspecified'}
- Profession: ${profile.profession || 'unspecified'}
- Industry: ${profile.industry || 'unspecified'}
- Interests: ${interests}

RULES:
1. REORDER stories within each section so the most relevant story for this reader appears first. Do not drop any stories. Do not add new stories.
2. For stories with high personal relevance (matches their industry, profession, city, or interests), you MAY append ONE additional short sentence at the end of the body explaining why this matters for them specifically. Keep the addition under 25 words. Do not be heavy-handed — most stories should be unchanged.
3. Do NOT change: headlines, sources, source_urls, markets indices, the date, the edition.
4. Do NOT change the "closer" object if present — leave it exactly as is.
5. Maintain the Morning Brief voice: warm, intelligent, never preachy.
6. Personalisation should be subtle. A casual reader should still get balanced global coverage.

Here is the standard brief:
${JSON.stringify(standardBrief, null, 2)}

Return the personalised brief as a JSON object with the EXACT same structure as the input. No markdown, no backticks, no commentary.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error(`No response from Haiku for ${edition}`);
  return extractJsonObject(text);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const today = getISTDate();
  const results: any[] = [];

  try {
    // 1. Fetch all users with personalised brief type
    const { data: users, error: usersErr } = await supabase
      .from('profiles')
      .select('id, city_current, city_home, profession, industry, interests, edition_preference, mood_preference, brief_type')
      .eq('brief_type', 'personalised');

    if (usersErr) throw new Error(`Profile fetch failed: ${usersErr.message}`);

    if (!users || users.length === 0) {
      return res.status(200).json({ success: true, message: 'No personalised users found.', today });
    }

    // 2. Fetch today's standard briefs once (shared input for all users)
    const { data: standardBriefs, error: briefsErr } = await supabase
      .from('briefs')
      .select('edition, content, status')
      .eq('date', today)
      .in('status', ['ready', 'fallback']);

    if (briefsErr) throw new Error(`Brief fetch failed: ${briefsErr.message}`);
    if (!standardBriefs || standardBriefs.length === 0) {
      return res.status(200).json({
        success: false,
        message: 'No standard briefs found for today. Run /api/generate-brief first.',
        today,
      });
    }

    const briefMap: Record<string, any> = {};
    standardBriefs.forEach((b: any) => { briefMap[b.edition] = b.content; });

    // 3. For each user, personalise each edition that exists
    for (const user of users as UserProfile[]) {
      const userResult: any = { user_id: user.id, editions: {} };

      for (const edition of ['5min', '10min', 'deep'] as Edition[]) {
        const standardContent = briefMap[edition];
        if (!standardContent) {
          userResult.editions[edition] = { status: 'skipped', reason: 'no standard brief' };
          continue;
        }

        try {
          const personalisedContent = await personaliseEdition(standardContent, edition, user);

          const { error: upsertErr } = await supabase
            .from('personalised_briefs')
            .upsert(
              {
                user_id: user.id,
                date: today,
                edition,
                status: 'ready',
                content: personalisedContent,
                generated_at: new Date().toISOString(),
              },
              { onConflict: 'user_id,date,edition' }
            );

          if (upsertErr) throw new Error(upsertErr.message);
          userResult.editions[edition] = { status: 'ready' };
        } catch (err: any) {
          console.error(`Failed to personalise ${edition} for user ${user.id}:`, err.message);
          userResult.editions[edition] = { status: 'failed', reason: err.message };
        }
      }

      results.push(userResult);
    }

    return res.status(200).json({ success: true, today, processed: results.length, results });

  } catch (error: any) {
    console.error('Personalisation error:', error.message);
    return res.status(500).json({ success: false, error: error.message, results });
  }
}
