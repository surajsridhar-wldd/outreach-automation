-- Applied to the live database on 2026-09-21 (safe to re-run).
-- Person-level redirect: everything DMS says is led by FROM is nudged to TO instead (an unofficial handover).
create table if not exists public.owner_redirects (
  from_dms_user_id text primary key,
  to_dms_user_id   text not null,
  note             text,
  created_at       timestamptz not null default now()
);
alter table public.owner_redirects enable row level security;
revoke all on public.owner_redirects from anon, authenticated;
grant select, insert, update, delete on public.owner_redirects to service_role;
