// src/lib/generate-brief/env.ts
//
// Modularization stage 1 — shared environment + clients, extracted verbatim from
// generate-brief.tsx. One home for the credentials and the Supabase client used
// across the pipeline. Behaviour is unchanged: these are the same declarations,
// only their file location moved. Per-section flags and PERPLEXITY_* stay with
// their sections for now and migrate with their module in later stages.

import { createClient } from '@supabase/supabase-js';

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
export const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
