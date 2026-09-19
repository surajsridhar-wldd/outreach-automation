# Outreach automation: finalised design (2026-09-20)

Source of truth for the rebuild. Everything here was agreed in chat unless marked TBD.

## 1. Principles
- Mongo (live DMS, Atlas, read-only) is the only source of truth for whether an issue is open. Replies never resolve anything; they only decide *when the next nudge is due* and who else is involved.
- Nothing is sent without a fresh Mongo check in the same run. Anything not flagged by the latest sync is dropped silently (no slot used, no message).
- Existing Supabase project and tables keep being used. No new Supabase project. No existing data is deleted.
- Only the 5 categories below are automated. Old categories/records (NO_SERVOCE_COST, WRONG_MARGINS__COMPLETED_, MISSING_DMS_ENTRY, REVENUE_MISMATCH, untagged) stay in the database and UI untouched, and are out of the automation.
- Cost: no model call for scheduling, templates, categories, matching. Model only reads *new* inbound replies, once each. Hard monthly cap in code plus a spend limit in the Anthropic Console.

## 2. The 5 categories (Mongo definitions; verified 2026-09-19/20 against the user's CSVs)
| # | Category | Rule | Count when verified |
|---|---|---|---|
| 1 | Pending invoice approvals | invoices.invoice_status = -2, reached via submissions -> invoice_submission_maps -> invoices, one per invoice per campaign | 14 (exact) |
| 2 | Pending creator submissions | creator_submissions: approved = 0 AND url non-blank string AND submitted_at is a date | 64 (exact) |
| 3 | Pending screenshot approvals | creator_submissions.latest_screenshot_status = 0 | 118 (user's screen 117; the extra row "Amazonian Dad x Wldd" is KEPT for now) |
| 4 | Pending closings | campaign_status in (Active, Approved) and UTC date of posting_end_date is >= 7 days before today. "On Hold" is excluded. Test campaigns are included | 60 (exact) |
| 5 | Pending proposals | campaign_status = Proposal and createdAt older than 14 days. Test campaigns included | 84 (exact) |

No campaign-status filter on categories 1-3 (every stage counts). Query design: never full-scan the live DB; scope creator_submissions lookups by campaign_id so the compound indexes are used.

## 3. Owner and people
- Recipient = campaigns.campaign_lead only. DMS co_campaign_lead is never contacted.
- Lead deleted/inactive/no user record (about 10 campaigns / 17 items at verification time): item goes to a "Needs owner" view on the website ONLY. No Slack DM, no count. User will say later how to handle these.
- Co-owner = someone the lead tags in a reply ("looping in X", "+X"). Per ISSUE, not per person. The tagged person receives only the items they were tagged on, and is nudged like the lead. The lead still receives all their items.
- Reassign is different: the sender disowns it ("not my campaign", "moved to X's team"). The same task moves to the new person, history kept, old owner stops being nudged.
  - Default when unsure: co-owner (worst case one extra person is nudged), flag it.
  - Exact identity comes from Slack mention IDs or CC'd emails; a bare ambiguous first name goes to the user's review queue.
  - Redirect chains (A->B->A, or more than 2 hops) go to the user's queue.
  - A campaign_lead change in DMS always wins and clears overrides.
  - Whether a tagged person can act in DMS is not our concern; if they can't, they will say so and the user handles it manually.

## 4. Schedule and run order
- Runs Mon/Wed/Fri around 11:00 IST. Extra: every working day from the 6th-last working day of the month, for invoice approvals only.
- Weekly categories (closings, proposals): due Wednesday, one message per lead bundling all their weekly items; they join that day's M/W/F message if the lead has both. Eligible on later run days until sent.
- Send window 11:00-19:00 IST, weekdays only, skip Indian holidays (holiday table).
- Each run, in order: read new replies -> pull Mongo -> hygiene (drop everything no longer flagged) -> decide who is due -> send.
- Trigger: Supabase pg_cron calls GitHub workflow_dispatch at 11:00 IST (GitHub's own cron is late by a median 2h45, up to 12h, measured on the exit repo). Watchdog alerts the user if a run is missed. The worker refuses to send outside the window.
- Setup the user must do: fine-grained GitHub token (Actions read/write on outreach-automation) stored in Supabase Vault as github_dispatch_token; repo secrets MONGODB_URI, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENCRYPTION_KEY, ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. Mongo URI lives only in GitHub Secrets, never in the public repo. (The read-only URI pasted in chat is NOT used and should be rotated.)

## 5. Nudge ladder
- Everything is a "nudge": N1 first notice, then follow-ups at least 2 working days apart (weekly categories: weekly). Spacing measured from the actual send time.
- Manager copied from N4 (manager source TBD). After N5 the item goes to the user's queue; no more automatic nudges.
- Invoice approvals: from the 6th-last working day of the month nudge every working day; last 2 working days a "final notice: approve or reject today".
- One bundled message per recipient per run, only their own items.

## 6. Queue, lanes and cap
- The queue is DERIVED each run, not a stored list of slots. If someone's items were cleared in Mongo by the time their turn comes, they are simply not in the list; no slot is used and the next person moves up.
- Lane A (first messages): people not yet messaged by the new system. Capped at 40 people per run, only during the ramp; cap switches off when the entry queue is empty. Order: invoice approvals, then creator/screenshot, then closings/proposals; longest-waiting first; skipped twice = moved to front.
- Lane B (follow-ups): people already in the system. Not capped. Bounded by people already contacted and by the 5-nudge limit.
- Fresh start for everyone: everyone gets a consolidated first message, ladder counts restart, old history kept, provided they are still flagged by the latest Mongo sync.
- Circuit breaker: if a run would message more than max(150, 2x the recent average), it sends nothing and alerts the user.
- Idempotent sends: message row written before sending; a crashed run resumes with no duplicates.

## 7. Reply handling
- Ledger: every outgoing message and every incoming message stored once, with true timestamps, quoted text/signatures stripped.
- Sources: Slack DMs and Gmail threads, including our own follow-up threads (follow-ups must reuse the original thread), replies from anyone in the email thread, and the user's own messages as context.
- One interpretation per message: input = that message + the numbered items it could answer + open items. Output per item: intent (done_claimed, promise_with_date, acknowledged, hold, waiting_on, redirect, loop_in, blocked, question, dispute, noise), date, target person, evidence quote, confidence. Low confidence -> user's review queue (abstain), never a guess.
- Model: Haiku 4.5 with a strict JSON schema; Sonnet 5 only for hard cases (multi-item bundles, low confidence). Validated on about 200 labelled real replies before go-live; results shown to the user.
- "Done" claims: never trusted. Checked at the next run's fresh Mongo pull (no separate run, no 2-hour buffer). If still open, the regular nudge says "you mentioned this was done, DMS still shows pending". A second false claim goes to the user's queue. Each false claim counts in the tracker.
- Holds: every hold has an expiry; on expiry the next run re-checks Mongo; still open -> back on the ladder (the missed promise is counted). Renewals capped.
  - Default holds: closing/proposal 14 days (max 21). Invoice approvals: short deferral only (about 3 working days), never in the month-end push. TBD: user unsure of exact numbers; tune from data.
  - Date mapping: promised date -> next nudge day strictly after it; "early next week" = Tuesday; no date + waiting = default hold; no date + "will check" = normal spacing.

## 7b. Channels: one channel per message, never both
- Default channel is EMAIL (from surajsridhar@wldd.in): threaded, so replies (including numbered per-item answers and replies from people looped in) are captured deterministically; supports CC for manager escalation and delegates; durable record.
- Follow-ups reuse the same email thread (the old code started a new thread each time, which hid replies).
- Slack is used for ONE short ping at the 3rd nudge ("following up on my email of <date> about N pending items") to raise visibility, never with the full item list. The 4th nudge onwards, and every manager copy, go by email.
- Never the same content in both places. Per-person and per-category overrides (`preferred_channel`) exist so the tracker can later switch someone who answers faster on Slack.
- Slack messages come from the owner's Slack account; both channels use the owner's already-connected tokens.
- STATUS: default agreed in principle, to be confirmed by the owner before go-live; shadow mode sends nothing either way.

## 8. Tracker (rebuilt)
Counts messages (touches), not issues. Track everything: new issues per person and category, nudges sent, nudges before resolution, first-reply time and resolve time (true timestamps), issue age, false "done" claims, holds requested and missed promises, reassigned away, escalations, recurrence after resolve. Two rankings: who causes the most issues, and who is slow even after repeated nudges. Resolution history logged properly (the old tool logged only 117 of 426 resolutions).

## 9. Data state (updated 2026-09-20)
- Backups: bak_20260920_contacts / outreach_records / outreach_history / categories (RLS on, no policies).
- Cleanup applied: 75 legacy records set to resolved with a Mongo-based note and a history event (44 closing, 23 proposal, 8 vendor approval). Verified against the backup: only those status changes, nothing deleted.
- Still open in the legacy tables for the 5 categories: closing 47 (all still on the Mongo list), vendor approval 13 (all still pending in Mongo), proposal 0. Categories 2 and 3 have no legacy records. The new system starts fresh from Mongo; legacy records are history only.
- Untouched, out of automation: NO_SERVOCE_COST 42 open, WRONG_MARGINS 36 open, untagged 4 open.
- Row Level Security enabled on all live tables, public-role privileges revoked (the app only uses the service_role key, which bypasses RLS; verified reads and writes still work, public key blocked). Before this, `categories` was actually readable and writable with the public key.
- New tables added (worker/sql/001_schema.sql): dms_people, issues, issue_owners, runs, messages_out, message_items, messages_in, interpretations, review_items, holidays, settings. All with RLS on and no public access.

## 10. Known issues in the old code to fix
Follow-up emails start a new thread so replies are missed; Slack follow-ups overwrite the message anchor; bundled email replies copied to every item; regex on the snippet matched the quoted template ("once done"); replied_at was check time not message time; every message re-judged daily; "Active" was a dead end; frequency tracker counted records and used stale dates; contacts table is one row per issue; RLS disabled on the live tables (awaiting the user's approval to enable).

## 11. Milestones (M1 in progress)
Done so far: calendar rules, planner (lanes, cap, ladder, holds, weekly slots, month-end push, circuit breaker) with 28 passing tests; Mongo queries for the 5 categories verified against the owner's CSVs; schema applied. M1 schema (additive) + Mongo extraction for the 5 categories + dry-run report checked against the user's counts. M2 message ledger + reply interpreter in shadow mode. M3 queue, ladder and sender in shadow mode (drafts only). M4 website views (Needs owner, review queue, tracker). M5 pg_cron trigger, watchdog, holiday table. M6 go-live in stages after the user reviews shadow output.

## 12. Open / TBD
Manager source (users.pod_id / cohort_id, pods, cohorts collections are candidates); exact hold caps for invoice approvals; handling of "Needs owner" items; the Amazonian Dad screenshot row; enabling RLS on live tables; rotating the pasted Mongo password.
