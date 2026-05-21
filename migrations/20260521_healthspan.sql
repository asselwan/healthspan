-- NOMOI Healthspan v1 — tables, indexes, RLS
--
-- Apply with:  psql "$DATABASE_URL" < migrations/20260521_healthspan.sql
-- DATABASE_URL is the Supabase project Postgres connection string
-- (Dashboard > Project Settings > Database > Connection string > URI).
-- The service-role / anon JWT cannot run DDL; a real Postgres connection
-- is required. This file is applied separately, e.g. via the Supabase
-- Management API or psql — the app never runs DDL itself.
--
-- All three tables live in the public schema on purpose. public is
-- exposed to PostgREST by default, so no exposed-schema change is needed.
-- A custom schema would need a manual exposed-schema toggle, and that
-- propagation has proven unreliable on the hosted project.

begin;

-- 1. Patients ------------------------------------------------------------
-- One row per person tracked in the longevity programme. Created either
-- by the clinician (dashboard) or by a patient's first intake round.
create table if not exists public.healthspan_patients (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  full_name     text not null,
  date_of_birth date,
  sex           text check (sex in ('female', 'male', 'other', 'undisclosed')),
  email         text,
  phone         text,

  -- The patient's most recent Cognitive Wellness score (0-100), entered
  -- by the clinician. Healthspan is the longitudinal layer of the
  -- deegha.health combo; Cognitive Wellness is the cognition tier.
  cognitive_wellness_score    numeric check (cognitive_wellness_score between 0 and 100),
  cognitive_wellness_dated_on date,

  notes         text
);

create index if not exists healthspan_patients_created_at_idx
  on public.healthspan_patients (created_at desc);
create index if not exists healthspan_patients_name_idx
  on public.healthspan_patients (lower(full_name));

-- 2. Intake rounds -------------------------------------------------------
-- The patient intake is designed to be RE-TAKEN periodically. Each
-- submission is a dated round tied to a patient. The readiness score is
-- computed deterministically on the client (see public/intake.js,
-- function computeReadiness) and stored alongside the raw answers so the
-- formula can be re-derived or re-run later.
create table if not exists public.healthspan_intake_rounds (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  -- A round can arrive before a clinician has created the patient row.
  -- patient_id is therefore nullable; the dashboard reconciles a round to
  -- a patient by patient_id when present, otherwise by patient_name.
  patient_id    uuid references public.healthspan_patients (id) on delete set null,
  patient_name  text not null,
  patient_email text,

  -- Lifestyle (Step 1)
  sleep_hours        numeric,   -- typical hours of sleep per night
  exercise_days      integer,   -- days per week with 30+ min activity
  nutrition_pattern  text,      -- 'whole_food' | 'mixed' | 'processed_heavy'
  alcohol_pattern    text,      -- 'none' | 'light' | 'moderate' | 'heavy'
  perceived_stress   integer,   -- 1 (low) .. 5 (high)
  smoking_status     text,      -- 'never' | 'former' | 'current'

  -- Goals + symptoms (Step 2)
  longevity_goals    jsonb not null default '[]'::jsonb,  -- array of goal strings
  symptoms           jsonb not null default '[]'::jsonb,  -- array of symptom strings

  -- History (Step 3)
  personal_history   jsonb not null default '[]'::jsonb,  -- array of condition strings
  family_history     jsonb not null default '[]'::jsonb,  -- array of condition strings

  -- Known measurements (Step 4) — all optional, patient-reported
  height_cm          numeric,
  weight_kg          numeric,
  resting_heart_rate integer,
  bp_systolic        integer,
  bp_diastolic       integer,

  -- Computed client-side, deterministic, 0-100. Higher is better.
  readiness_score    numeric not null check (readiness_score between 0 and 100),
  -- Snapshot of the per-component contributions for transparency.
  readiness_breakdown jsonb not null default '{}'::jsonb,

  consent_store      boolean not null default false,
  consent_share      boolean not null default false,

  user_agent         text
);

create index if not exists healthspan_rounds_patient_idx
  on public.healthspan_intake_rounds (patient_id, created_at desc);
create index if not exists healthspan_rounds_created_at_idx
  on public.healthspan_intake_rounds (created_at desc);
create index if not exists healthspan_rounds_name_idx
  on public.healthspan_intake_rounds (lower(patient_name));

-- 3. Lab biomarkers ------------------------------------------------------
-- Dated lab values entered by the clinician on the dashboard. One row per
-- (patient, marker, sample date). Trend charts read these grouped by
-- marker_key.
create table if not exists public.healthspan_biomarkers (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  patient_id    uuid not null references public.healthspan_patients (id) on delete cascade,

  -- A stable key for the marker, e.g. 'fasting_glucose', 'hba1c', 'apob',
  -- 'hscrp', 'triglycerides', 'ldl', 'hdl'. The dashboard offers a known
  -- set but the column accepts any key so the panel can grow.
  marker_key    text not null,
  marker_label  text not null,
  value         numeric not null,
  unit          text,
  sampled_on    date not null,
  note          text
);

create index if not exists healthspan_biomarkers_patient_idx
  on public.healthspan_biomarkers (patient_id, marker_key, sampled_on);

-- 4. Row Level Security --------------------------------------------------
alter table public.healthspan_patients      enable row level security;
alter table public.healthspan_intake_rounds enable row level security;
alter table public.healthspan_biomarkers    enable row level security;

-- The patient intake SPA uses the anon key. It may INSERT a patient row
-- (a brand-new person taking their first round) and INSERT an intake
-- round. It can never read, update, or delete. The clinician dashboard
-- reads through an operator-entered service-role key, never the anon key.

drop policy if exists "anon can insert patient" on public.healthspan_patients;
create policy "anon can insert patient"
  on public.healthspan_patients
  for insert
  to anon
  with check (true);

drop policy if exists "anon can insert intake round" on public.healthspan_intake_rounds;
create policy "anon can insert intake round"
  on public.healthspan_intake_rounds
  for insert
  to anon
  with check (true);

-- No anon policy on healthspan_biomarkers == anon cannot touch it at all.
-- No select/update/delete policy for anon on any table == those
-- operations are denied for the public client.

-- The clinician dashboard authenticates with the service-role key, which
-- bypasses RLS entirely, so it already has full read/write on all three
-- tables. No additional grant is required for the service role. If a
-- scoped Postgres role is introduced later for the clinician, grant it
-- here:
--   grant select, insert, update, delete
--     on public.healthspan_patients,
--        public.healthspan_intake_rounds,
--        public.healthspan_biomarkers
--     to <clinician_role>;

commit;

-- ------------------------------------------------------------------------
-- POST-APPLY CHECK
--   select count(*) from public.healthspan_patients;       -- expect 0
--   select count(*) from public.healthspan_intake_rounds;  -- expect 0
--   select count(*) from public.healthspan_biomarkers;     -- expect 0
--   select tablename, rowsecurity from pg_tables
--     where schemaname = 'public'
--       and tablename like 'healthspan_%';                 -- rowsecurity = t
-- ------------------------------------------------------------------------
