-- Applied 2026-09-20. Tables created by the earlier migrations had no privileges for the
-- server-side key, so the first run failed with "permission denied". Grant service_role only;
-- anon and authenticated remain fully blocked.
grant select, insert, update, delete on
  public.dms_people, public.issues, public.issue_owners, public.runs, public.messages_out,
  public.message_items, public.messages_in, public.interpretations, public.review_items,
  public.holidays, public.settings
to service_role;
