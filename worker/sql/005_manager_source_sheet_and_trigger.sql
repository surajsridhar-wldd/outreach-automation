-- Applied 2026-09-20.
-- 1) managers may now come from the company team sheet
alter table public.dms_people drop constraint if exists dms_people_manager_source_check;
alter table public.dms_people add constraint dms_people_manager_source_check check (manager_source in ('sheet','cohort','pod'));

-- 2) scheduled trigger: Supabase starts the workflow on time (GitHub's own schedule runs hours late).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Reads a GitHub token from Vault (secret name: github_dispatch_token); never stored in this repo.
create or replace function public.dispatch_nudge_run(p_mode text default null)
returns bigint language plpgsql security definer set search_path = public, vault, net as $$
declare tok text; req bigint; payload jsonb;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1;
  if tok is null then raise exception 'github_dispatch_token is not set in Vault'; end if;
  payload := jsonb_build_object('ref', 'main');
  if p_mode is not null then payload := payload || jsonb_build_object('inputs', jsonb_build_object('mode', p_mode)); end if;
  select net.http_post(
    url := 'https://api.github.com/repos/surajsridhar-wldd/outreach-automation/actions/workflows/nudge-run.yml/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
                                  'X-GitHub-Api-Version', '2022-11-28', 'User-Agent', 'supabase-pg-cron', 'Content-Type', 'application/json'),
    body := payload) into req;
  return req;
end $$;

-- Second chance: if no successful run has happened today (IST), start one.
create or replace function public.dispatch_nudge_run_if_missing()
returns bigint language plpgsql security definer set search_path = public as $$
declare done_today boolean;
begin
  select exists (select 1 from public.runs where ok = true
                 and started_at >= ((date_trunc('day', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata')) into done_today;
  if done_today then return null; end if;
  return public.dispatch_nudge_run();
end $$;

revoke all on function public.dispatch_nudge_run(text) from public, anon, authenticated;
revoke all on function public.dispatch_nudge_run_if_missing() from public, anon, authenticated;

-- Mon-Fri 11:00 IST (05:30 UTC), and a retry at 14:00 IST. The run itself decides whether today is a nudge day.
select cron.schedule('nudge-dispatch-1100-ist', '30 5 * * 1-5', 'select public.dispatch_nudge_run()');
select cron.schedule('nudge-dispatch-retry-1400-ist', '30 8 * * 1-5', 'select public.dispatch_nudge_run_if_missing()');
