-- =============================================
-- MORNING BRIEF — SCHEMA UPDATE v2
-- Run this in Supabase SQL Editor
-- This adds new columns to the profiles table
-- =============================================

alter table profiles
  add column if not exists life_stage text,
  add column if not exists work_area text,
  add column if not exists study_area text,
  add column if not exists study_level text,
  add column if not exists extra_cities text[] default '{}',
  add column if not exists brief_type text default 'standard' check (brief_type in ('standard', 'personalised'));
