-- Applied to the live database on 2026-09-20 (record of what is there; safe to re-run).

alter table public.runs drop constraint if exists runs_mode_check;
alter table public.runs add constraint runs_mode_check check (mode in ('shadow','rehearsal','canary','live'));

alter table public.issues     add column if not exists claimed_done_at timestamptz;
alter table public.dms_people add column if not exists unreachable_at timestamptz, add column if not exists unreachable_reason text;
alter table public.messages_in add column if not exists from_owner boolean, add column if not exists headers jsonb;

alter table public.review_items drop constraint if exists review_items_kind_check;
alter table public.review_items add constraint review_items_kind_check check (kind in
  ('needs_owner','low_confidence','ambiguous_redirect','ladder_exhausted','false_done_twice',
   'dispute','question','blocked','manager_missing','send_failed','sync_guard'));

insert into public.settings (key, value) values ('paused', 'false') on conflict (key) do nothing;

create or replace view public.nudge_category_stats as
select category,
  count(*) filter (where state = 'open') as open_issues,
  count(*) filter (where state = 'cleared') as cleared_issues,
  count(*) as issues_total,
  coalesce(sum(nudge_count), 0)::int as nudges_total,
  round(avg(nudge_count) filter (where state = 'cleared' and nudge_count > 0), 1) as avg_nudges_before_clear,
  round(avg(extract(epoch from (cleared_at - first_seen_at)) / 86400) filter (where state = 'cleared'), 1) as avg_days_to_clear,
  round(avg(extract(epoch from (now() - first_seen_at)) / 86400) filter (where state = 'open'), 1) as avg_open_age_days
from public.issues i group by category;

create or replace view public.nudge_person_stats as
select p.dms_user_id, p.name, p.email, p.manager_email,
  count(i.id) filter (where i.state = 'open') as open_issues,
  count(i.id) as issues_total,
  coalesce(sum(i.nudge_count), 0)::int as nudges_total,
  round(avg(i.nudge_count) filter (where i.state = 'cleared' and i.nudge_count > 0), 1) as avg_nudges_before_clear,
  round(avg(extract(epoch from (i.cleared_at - i.first_seen_at)) / 86400) filter (where i.state = 'cleared'), 1) as avg_days_to_clear,
  round(avg(extract(epoch from (now() - i.first_seen_at)) / 86400) filter (where i.state = 'open'), 1) as avg_open_age_days,
  count(i.id) filter (where i.state = 'open' and i.nudge_count >= 3) as open_after_3_nudges,
  coalesce(sum(i.false_done_claims), 0)::int as false_done_claims,
  coalesce(sum(i.hold_renewals), 0)::int as hold_renewals,
  (select count(*) from public.issue_owners o where o.replaces_dms_user_id = p.dms_user_id)::int as reassigned_away
from public.dms_people p left join public.issues i on i.owner_dms_user_id = p.dms_user_id
group by p.dms_user_id, p.name, p.email, p.manager_email;

create or replace view public.nudge_weekly as
select date_trunc('week', first_seen_at)::date as week, category, count(*) as new_issues,
  count(*) filter (where state = 'cleared') as cleared_since
from public.issues i group by 1, category;

revoke all on public.nudge_category_stats, public.nudge_person_stats, public.nudge_weekly from anon, authenticated;
grant select on public.nudge_category_stats, public.nudge_person_stats, public.nudge_weekly to service_role;
