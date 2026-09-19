-- Mongo-driven nudge system: additive schema (nothing existing is altered or dropped).
-- Applied to the live Supabase project on 2026-09-20. Existing tables (users, contacts,
-- outreach_records, outreach_history, categories) are untouched.
--
-- Grain: one "issue" = one (category, campaign) that Mongo currently reports as pending,
-- with a count of pending items. It is opened and cleared by the Mongo sync, never by hand.

-- Fix the linter warning on the existing helper (behaviour unchanged).
alter function public.touch_updated_at() set search_path = public, pg_temp;

-- DMS users we message (campaign leads and anyone they loop in).
create table if not exists public.dms_people (
  dms_user_id      text primary key,
  name             text,
  email            text,
  is_deleted       boolean,
  slack_user_id    text,
  slack_checked_at timestamptz,
  preferred_channel text check (preferred_channel in ('email','slack')),
  manager_email    text,                      -- filled in later (source TBD)
  entered_at       timestamptz,               -- first message sent by the new system (lane A -> lane B)
  skipped_count    int not null default 0,    -- times deferred by the entry cap
  updated_at       timestamptz not null default now()
);

create table if not exists public.issues (
  id                uuid primary key default gen_random_uuid(),
  category          text not null check (category in
                      ('invoice_approvals','creator_submissions','screenshot_approvals','pending_closings','pending_proposals')),
  campaign_id       text not null,
  campaign_name     text,
  campaign_status   text,
  owner_dms_user_id text,                     -- campaigns.campaign_lead (Mongo is authoritative)
  owner_state       text check (owner_state in ('active','deleted','missing')),
  item_count        int not null default 1,
  detail            jsonb not null default '{}'::jsonb,
  state             text not null default 'open' check (state in ('open','cleared')),
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  cleared_at        timestamptz,
  clear_reason      text,
  nudge_count       int not null default 0,
  last_nudged_at    timestamptz,
  hold_until        date,                     -- nudging resumes strictly after this date
  hold_reason       text,
  hold_renewals     int not null default 0,
  false_done_claims int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- Only one OPEN issue per (category, campaign); a recurrence after clearing is a new row.
create unique index if not exists issues_one_open_per_key on public.issues (category, campaign_id) where state = 'open';
create index if not exists issues_state_category_idx on public.issues (state, category);
create index if not exists issues_open_owner_idx on public.issues (owner_dms_user_id) where state = 'open';

-- Co-owners and reassignments, per issue. The DMS lead stays on issues.owner_dms_user_id.
create table if not exists public.issue_owners (
  id                   uuid primary key default gen_random_uuid(),
  issue_id             uuid not null references public.issues(id) on delete cascade,
  dms_user_id          text not null,
  role                 text not null check (role in ('co_owner','reassigned_to')),
  replaces_dms_user_id text,
  lead_at_creation     text,                  -- if Mongo's lead changes, the override is dropped
  source_message_in_id uuid,
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);
create index if not exists issue_owners_issue_idx on public.issue_owners (issue_id) where active;

create table if not exists public.runs (
  id          uuid primary key default gen_random_uuid(),
  mode        text not null check (mode in ('shadow','live')),
  trigger     text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  stats       jsonb not null default '{}'::jsonb,
  error       text
);

-- Every outgoing message, written BEFORE it is sent so a crashed run can resume without duplicates.
create table if not exists public.messages_out (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid references public.runs(id),
  recipient_dms_user_id  text not null,
  channel                text not null check (channel in ('email','slack')),
  lane                   text check (lane in ('A','B')),
  kind                   text check (kind in ('first','followup','final')),
  status                 text not null default 'planned' check (status in ('planned','sending','sent','failed','draft')),
  to_address             text,
  cc_addresses           text[],
  slack_channel_id       text,
  subject                text,
  body                   text,
  gmail_message_id       text,
  gmail_thread_id        text,
  slack_ts               text,
  error                  text,
  created_at             timestamptz not null default now(),
  sent_at                timestamptz,
  unique (run_id, recipient_dms_user_id, channel)
);

create table if not exists public.message_items (
  message_out_id uuid not null references public.messages_out(id) on delete cascade,
  issue_id       uuid not null references public.issues(id),
  item_no        int,            -- number shown in the message so replies can answer "1.", "2."
  nudge_no       int,
  primary key (message_out_id, issue_id)
);

-- Every incoming message, stored once, with its TRUE timestamp and quoted text stripped.
create table if not exists public.messages_in (
  id                        uuid primary key default gen_random_uuid(),
  channel                   text not null check (channel in ('email','slack')),
  external_id               text not null,          -- gmail message id / slack ts
  thread_ref                text,
  sender_address            text,
  sender_dms_user_id        text,
  received_at               timestamptz not null,
  clean_text                text,
  raw_text                  text,
  in_reply_to_message_out_id uuid references public.messages_out(id),
  processed_at              timestamptz,
  created_at                timestamptz not null default now(),
  unique (channel, external_id)
);

create table if not exists public.interpretations (
  id                 uuid primary key default gen_random_uuid(),
  message_in_id      uuid not null references public.messages_in(id) on delete cascade,
  issue_id           uuid references public.issues(id),
  intent             text not null check (intent in
                       ('done_claimed','promise_with_date','acknowledged','hold','waiting_on','redirect',
                        'loop_in','blocked','question','dispute','noise','other')),
  promised_date      date,
  hold_days          int,
  target_dms_user_id text,
  target_text        text,
  evidence           text,
  confidence         numeric,
  needs_review       boolean not null default false,
  model              text,
  tokens_in          int,
  tokens_out         int,
  cost_usd           numeric(10,6),
  created_at         timestamptz not null default now()
);

-- Things that need a human: shown on the website, never sent to Slack.
create table if not exists public.review_items (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in
                   ('needs_owner','low_confidence','ambiguous_redirect','ladder_exhausted','false_done_twice',
                    'dispute','question','blocked')),
  issue_id       uuid references public.issues(id),
  message_in_id  uuid references public.messages_in(id),
  note           text,
  status         text not null default 'open' check (status in ('open','done')),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);
create index if not exists review_items_open_idx on public.review_items (kind) where status = 'open';

create table if not exists public.holidays (
  day  date primary key,
  name text
);

create table if not exists public.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.settings (key, value) values
  ('mode',            '"shadow"'),
  ('lane_a_cap',      '40'),
  ('ramp_active',     'true'),
  ('send_window',     '{"start_hour":11,"end_hour":19}'),
  ('llm_monthly_cap_usd', '3')
on conflict (key) do nothing;

-- updated_at maintenance
drop trigger if exists issues_touch on public.issues;
create trigger issues_touch before update on public.issues for each row execute function public.touch_updated_at();
drop trigger if exists dms_people_touch on public.dms_people;
create trigger dms_people_touch before update on public.dms_people for each row execute function public.touch_updated_at();

-- Security: server-side only (service_role bypasses RLS). No policies, no public-role privileges.
do $$
declare t text;
begin
  foreach t in array array['dms_people','issues','issue_owners','runs','messages_out','message_items',
                           'messages_in','interpretations','review_items','holidays','settings']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
