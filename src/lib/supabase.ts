import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

export type Profile = {
  id: string
  email: string
  full_name: string
  age: number
  gender: string
  city_current: string
  city_home: string
  extra_cities: string[]
  profession: string
  life_stage: string
  work_area: string
  study_area: string
  study_level: string
  industry: string
  company: string
  interests: string[]
  mood_preference: 'neutral' | 'optimistic' | 'critical'
  edition_preference: 'ultra' | 'standard' | 'deep'
  brief_type: 'standard' | 'personalised'
  created_at: string
  updated_at: string
}