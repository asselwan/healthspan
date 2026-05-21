/* NOMOI Healthspan — runtime configuration.
 *
 * The anon key below is a PUBLIC, non-secret token by design. It is safe
 * to ship in client code. What protects the data is Row Level Security:
 * the migration grants anon INSERT only on healthspan_patients and
 * healthspan_intake_rounds, and nothing at all on healthspan_biomarkers.
 *
 * All three tables live in the public schema. public is exposed to
 * PostgREST by default, so no exposed-schema change is needed.
 *
 * The service-role key is NEVER placed here. The clinician dashboard
 * collects it at runtime; it lives only in that browser tab's memory.
 */
window.__HEALTHSPAN_CONFIG = {
  SUPABASE_URL: 'https://umodapwphcxtiijizqll.supabase.co',

  // Supabase anon (public) key — safe in client code by design. RLS
  // restricts it to INSERT on patients and intake rounds only. Until the
  // migration is applied, the intake runs in demo mode: it validates,
  // scores, and shows the confirmation screen but does not write.
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtb2RhcHdwaGN4dGlpaml6cWxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4NDY4NTksImV4cCI6MjA5MTQyMjg1OX0.n-78X7umWxX-0N3Ssl8LRKhORaVIPe1SgkXf0MpG5sM',

  SCHEMA: 'public',
  PATIENTS_TABLE: 'healthspan_patients',
  ROUNDS_TABLE: 'healthspan_intake_rounds',
  BIOMARKERS_TABLE: 'healthspan_biomarkers',

  // Shared passcode that gates the clinician dashboard for v1.
  // Change this before sharing the dashboard link.
  CLINIC_PASSCODE: 'healthspan2026',

  // NOMOI document-extraction backend. The dashboard uploads a lab PDF to
  // Supabase Storage, then asks this service to read it and write the
  // biomarker rows. No secret is stored here: the call is authorised with
  // the service-role key the clinician already entered at runtime.
  EXTRACT_API_BASE: 'https://docextract.nomoi.ai',
  LABS_BUCKET: 'healthspan-labs'
};
