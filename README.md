# NOMOI Healthspan

The longitudinal healthspan layer of the deegha.health combo. It tracks how
a person is ageing over time rather than capturing a single snapshot.

Healthspan is two surfaces of one product:

- **Healthspan Intake** at `/intake` — a repeatable patient intake. Each
  submission is a dated round. The patient gets a readiness score they can
  watch across rounds.
- **Healthspan Dashboard** at `/` and `/dashboard` — the clinician view.
  Pick a patient and see every round's readiness score over time, lab
  biomarker trends, the Cognitive Wellness score, and a patient summary.

The intake feeds the dashboard. They share one Supabase project.

## What is in here

```
public/
  intake.html      Patient longevity intake — five-step single-page app
  intake.js        Intake flow: validation, scoring, Supabase write
  dashboard.html   Clinician dashboard — patient picker + longitudinal view
  dashboard.js     Dashboard logic: charts, biomarker + cognition entry
  config.js        Runtime config (Supabase URL, anon key, passcode)
migrations/
  20260521_healthspan.sql   Three tables, indexes, RLS — all in public
Dockerfile         Static nginx image
nginx.conf         Routing: / and /dashboard serve the dashboard,
                   /intake serves the patient intake
```

No build step. Each page loads the Supabase JS client from a CDN and talks
to Supabase directly.

## The readiness score

The score is computed deterministically on the patient's device from their
lifestyle and symptom answers. The formula is documented in full in
`public/intake.js` (`computeReadiness` and the comment block above it).

In short: a baseline of 50, moved by six lifestyle components — sleep,
activity, nutrition, alcohol, smoking, stress — each with a fixed maximum
contribution and a 0..1 quality factor derived only from the answer.
Current symptoms subtract 3 points each, capped at 15. The total is clamped
to 0..100. The maximum reachable score is 100; the minimum is 35.

The per-component breakdown is shown to the patient on the confirmation
screen and stored alongside the round in `readiness_breakdown`, so the
score can always be re-derived. It is a readiness indicator, not a
diagnosis.

## Data model

Three tables, all in the `public` schema (it is exposed to PostgREST by
default — no exposed-schema toggle is needed):

- `public.healthspan_patients` — one row per tracked person. Carries the
  clinician-entered Cognitive Wellness score.
- `public.healthspan_intake_rounds` — one row per dated intake round, with
  the raw answers and the computed readiness score.
- `public.healthspan_biomarkers` — dated lab values entered by the
  clinician, one row per (patient, marker, sample date).

## Setup

### 1. Apply the migration

```
psql "$DATABASE_URL" < migrations/20260521_healthspan.sql
```

`DATABASE_URL` is the project's Postgres connection string from Supabase
Dashboard > Project Settings > Database > Connection string (URI). The
service-role / anon JWT cannot run DDL — a real Postgres connection is
required. The app never runs DDL itself; the migration is applied
separately, for example via the Supabase Management API.

No exposed-schema change is needed because all three tables live in
`public`.

### 2. Confirm the anon key

`public/config.js` already carries the NOMOI project's anon key. The anon
key is a public, non-secret token by design. Row Level Security is what
protects the data: the migration grants `anon` INSERT only on
`healthspan_patients` and `healthspan_intake_rounds`, and nothing at all on
`healthspan_biomarkers` — never read, update, or delete.

Until the migration is applied, the intake runs in demo mode: it validates,
scores, and shows the confirmation screen but does not write to Supabase.

### 3. Change the dashboard passcode

Set `CLINIC_PASSCODE` in `public/config.js` before sharing the dashboard
link.

## Running locally

```
docker build -t healthspan .
docker run --rm -p 8080:80 healthspan
```

Patient intake: `http://localhost:8080/intake`
Clinician dashboard: `http://localhost:8080/`

Or serve `public/` with any static server.

## The dashboard and the read key

Patient records are private. RLS gives `anon` INSERT only on two tables and
no access at all to biomarkers, so a static page cannot safely hold a key
that can read or write patient data.

For v1 the clinician enters two things on the gate screen: the shared
passcode and a read key (the project service-role key). The read key lives
only in that browser tab's memory — it is never written into the repo, the
page, or any storage.

This is a deliberate v1 trade-off, the same one used in the NOMOI Front
Desk repo's `/clinic` view. A hosted multi-clinic version replaces it with
a thin authenticated backend route that holds the service key server-side
and serves the clinician a scoped, audited read.

## NOMOI surface

Both pages carry `data-nomoi-surface="healthspan.nomoi.ai"`, the inline
Surface emitter, `surface-motion.js`, and the theta NOMΘI wordmark. The
intake also loads the deegha customer-comms widget. The intake emits step
views, blocked steps, and submit outcomes; the dashboard emits unlocks,
patient selections, and entry events, so the funnel is measurable.

## v1 vs future

v1 ships, working end to end once the migration is applied:

- Five-step repeatable patient intake with inline validation and a
  progress indicator
- A deterministic, transparent readiness score shown with a per-component
  breakdown on the confirmation screen
- Each submission stored as a dated round so the score becomes a trend
- A passcode-gated clinician dashboard: patient picker, add-patient form,
  longitudinal readiness chart, an intake-rounds table
- Dated lab biomarker entry with a hand-rolled SVG trend chart per marker
- A Cognitive Wellness score field (the cognition tier of the combo)
- A patient healthspan summary that can be printed or saved as a PDF
- RLS that limits the public client to inserts on two tables only

Not in v1, deliberately — these are roadmap, not faked:

- Automatic extraction of lab values from an uploaded lab-report PDF. v1
  is structured manual entry; PDF extraction needs a backend.
- Oura or Whoop wearable sync. That needs an OAuth integration and a
  backend to hold tokens and poll.
- A backend route for the dashboard (v1 uses an operator-entered read key)
- Per-clinic accounts and a link issuer (v1 uses one shared deployment)
- Editing or archiving rounds from the dashboard (the dashboard is read
  plus append: it adds biomarkers and the cognition score, but does not
  edit existing rounds)

---

A NOMΘI product. The longitudinal layer of the deegha.health combo.
