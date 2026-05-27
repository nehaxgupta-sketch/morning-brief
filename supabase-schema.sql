-- =============================================
-- MORNING BRIEF — DATABASE SCHEMA
-- Run this in Supabase SQL Editor
-- Dashboard → SQL Editor → New Query → Paste → Run
-- =============================================

-- PROFILES TABLE
-- Stores every user's personal profile
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  email text unique not null,
  full_name text,
  age integer,
  gender text,
  city_current text,
  city_home text,
  profession text,
  industry text,
  company text,
  interests text[] default '{}',
  mood_preference text default 'neutral' check (mood_preference in ('neutral', 'optimistic', 'critical')),
  edition_preference text default 'standard' check (edition_preference in ('ultra', 'standard', 'deep')),
  onboarding_complete boolean default false,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- BRIEFS TABLE
-- Stores each day's generated news brief
create table if not exists briefs (
  id uuid default gen_random_uuid() primary key,
  date date not null unique,
  ultra_content jsonb,
  standard_content jsonb,
  deep_content jsonb,
  generated_at timestamp with time zone default timezone('utc'::text, now()),
  status text default 'pending' check (status in ('pending', 'generating', 'ready', 'failed'))
);

-- BOOKMARKS TABLE
-- Stores stories a user has bookmarked / is following
create table if not exists bookmarks (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id) on delete cascade,
  brief_date date not null,
  story_headline text not null,
  story_category text,
  notes text,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  unique(user_id, brief_date, story_headline)
);

-- HABIT PLANS TABLE
-- Pre-built 30-day habit plans
create table if not exists habit_plans (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  goal_category text not null,
  description text,
  duration_days integer default 30,
  habits jsonb not null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- USER HABITS TABLE
-- Tracks which plan a user is on and their progress
create table if not exists user_habits (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id) on delete cascade,
  plan_id uuid references habit_plans(id),
  start_date date not null,
  current_day integer default 1,
  streak integer default 0,
  longest_streak integer default 0,
  last_checked_in date,
  completed boolean default false,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  unique(user_id, plan_id, start_date)
);

-- HABIT CHECKINS TABLE
-- Records each daily check-in
create table if not exists habit_checkins (
  id uuid default gen_random_uuid() primary key,
  user_habit_id uuid references user_habits(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  checkin_date date not null,
  day_number integer not null,
  completed boolean default false,
  note text,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  unique(user_habit_id, checkin_date)
);

-- ROW LEVEL SECURITY
-- Makes sure users can only see their own data
alter table profiles enable row level security;
alter table bookmarks enable row level security;
alter table user_habits enable row level security;
alter table habit_checkins enable row level security;
alter table briefs enable row level security;
alter table habit_plans enable row level security;

-- POLICIES — profiles
create policy "Users can view own profile" on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
create policy "Users can insert own profile" on profiles for insert with check (auth.uid() = id);

-- POLICIES — bookmarks
create policy "Users can manage own bookmarks" on bookmarks for all using (auth.uid() = user_id);

-- POLICIES — user_habits
create policy "Users can manage own habits" on user_habits for all using (auth.uid() = user_id);

-- POLICIES — habit_checkins
create policy "Users can manage own checkins" on habit_checkins for all using (auth.uid() = user_id);

-- POLICIES — briefs (everyone can read, only server can write)
create policy "Anyone can read briefs" on briefs for select using (true);

-- POLICIES — habit_plans (everyone can read)
create policy "Anyone can read habit plans" on habit_plans for select using (true);

-- AUTO-UPDATE updated_at on profiles
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$ language plpgsql;

create trigger update_profiles_updated_at
  before update on profiles
  for each row execute procedure update_updated_at_column();

-- AUTO-CREATE profile when user signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
