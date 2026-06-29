-- ============================================================================
-- Ops Outreach Tracker — Spec build migration
-- Run this in Supabase SQL Editor BEFORE deploying the new code.
-- Safe to re-run (IF NOT EXISTS / idempotent).
-- ============================================================================

-- 1. Categories table (user-defined, runtime-extensible) ----------------------
CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  tag text NOT NULL,
  name text NOT NULL,
  description text,
  done_definition text,
  is_time_sensitive boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Unique tag per user (so two users can have their own sets; org-wide rows use a fixed user_id).
CREATE UNIQUE INDEX IF NOT EXISTS categories_user_tag_idx ON categories (user_id, tag);

-- 2. New columns on outreach_records -----------------------------------------
ALTER TABLE outreach_records ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE outreach_records ADD COLUMN IF NOT EXISTS category_confidence numeric;
ALTER TABLE outreach_records ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
ALTER TABLE outreach_records ADD COLUMN IF NOT EXISTS batch_id uuid;
-- backfill_checked: transient marker so the one-time attribution backfill can loop
-- without re-processing the same record. Safe to leave; reset to NULL to re-run.
ALTER TABLE outreach_records ADD COLUMN IF NOT EXISTS backfill_checked boolean;

-- 3. Status constraint: add 'snoozed'. Keep 'monitoring' so existing rows stay valid
--    during migration; we migrate monitoring -> snoozed in code/below, then it's unused.
ALTER TABLE outreach_records DROP CONSTRAINT IF EXISTS outreach_records_status_check;
ALTER TABLE outreach_records ADD CONSTRAINT outreach_records_status_check
  CHECK (status IN ('pending','sent','active','no_reply','followup','stalled','needs_review','monitoring','snoozed','resolved','escalated'));

-- 4. Migrate existing 'monitoring' records to 'snoozed' with a far-future date
--    (preserves them; they resurface only when you change the date). Comment out
--    if you want to keep Monitor semantics for now.
UPDATE outreach_records
  SET status = 'snoozed', snoozed_until = now() + interval '3650 days'
  WHERE status = 'monitoring';

-- 5. Seed the 5 initial categories for the primary admin user.
--    Replace :USER_ID below with your user id, OR leave user_id NULL for org-wide.
--    Find your id: SELECT id, email FROM users;  (or whatever your users table is)
--    These use ON CONFLICT so re-running won't duplicate.
INSERT INTO categories (user_id, tag, name, description, done_definition, is_time_sensitive) VALUES
  (NULL, 'REVENUE_MISMATCH', 'Revenue mismatch',
   'The value reported by finance does not match the value present on DMS. The POC must recheck the value and update DMS if a change is needed.',
   'Values reconciled on DMS', false),
  (NULL, 'MISSING_DMS_ENTRY', 'Missing in DMS entries',
   'Finance does not know whether a DMS record exists for a given mail-chain subject/campaign. Verify whether one exists and get its name.',
   'DMS record confirmed and named', false),
  (NULL, 'PENDING_CLOSURE', 'Pending closure',
   'A campaign has crossed its posting end date and must be marked complete. If it is still live, the POC must extend the posting end date.',
   'Marked complete or posting end date extended', false),
  (NULL, 'PENDING_PROPOSAL', 'Pending proposals',
   'A campaign whose brief was received and initial pitch done is stuck in proposal stage on DMS. If progressing, set to approved; if not happening, set to cancelled.',
   'Set to approved or cancelled', false),
  (NULL, 'PENDING_VENDOR_APPROVAL', 'Pending vendor submission approval',
   'A vendor has posted proof of work and raised an invoice. The campaign team must verify and approve or reject. If it reaches month-end it auto-rejects and harms the vendor relationship.',
   'Approved or rejected', true)
ON CONFLICT (user_id, tag) DO NOTHING;

-- Note: ON CONFLICT with NULL user_id — Postgres treats NULLs as distinct in unique
-- indexes, so the conflict target may not fire for NULL user_id. If you re-run and see
-- duplicates, dedupe with:
--   DELETE FROM categories a USING categories b
--   WHERE a.ctid < b.ctid AND a.user_id IS NOT DISTINCT FROM b.user_id AND a.tag = b.tag;
