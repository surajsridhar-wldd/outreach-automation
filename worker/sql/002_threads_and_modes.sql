-- Applied to the live Supabase project on 2026-09-20 (after 001_schema.sql).
-- Per-person email thread so follow-ups reuse it, Slack DM channel, and the run mode per message.
-- NOTE: the matching rows in `settings` (sender_user_email, rehearsal_redirect_to, canary_allowlist)
-- are set directly in the database and intentionally not stored in this public repo.

alter table public.dms_people
  add column if not exists email_thread_id      text,
  add column if not exists email_rfc_message_id text,
  add column if not exists email_subject        text,
  add column if not exists slack_dm_channel_id  text;

alter table public.messages_out
  add column if not exists mode        text check (mode in ('shadow','rehearsal','canary','live')),
  add column if not exists intended_to text;

alter table public.review_items drop constraint if exists review_items_kind_check;
alter table public.review_items add constraint review_items_kind_check check (kind in
  ('needs_owner','low_confidence','ambiguous_redirect','ladder_exhausted','false_done_twice',
   'dispute','question','blocked','manager_missing','send_failed','sync_guard'));
