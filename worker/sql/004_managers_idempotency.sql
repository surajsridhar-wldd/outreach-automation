-- Applied 2026-09-20. Manager lookup from DMS, unconfirmed-send status, and send idempotency.
alter table public.dms_people
  add column if not exists manager_name           text,
  add column if not exists manager_source         text check (manager_source in ('cohort','pod')),
  add column if not exists manager_override_email text;

alter table public.messages_out drop constraint if exists messages_out_status_check;
alter table public.messages_out add constraint messages_out_status_check
  check (status in ('planned','sending','sent','failed','draft','unknown'));

create table if not exists public.send_log (
  idempotency_key text primary key,
  status          text not null check (status in ('pending','done')),
  result          jsonb,
  created_at      timestamptz not null default now()
);
alter table public.send_log enable row level security;
revoke all on public.send_log from anon, authenticated;
grant select, insert, update, delete on public.send_log to service_role;
