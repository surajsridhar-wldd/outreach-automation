import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { categorizeIssuesBatch } from "@/lib/claude";
import { getCategories } from "@/lib/categories";

export const maxDuration = 120;

// Batched category tagging for the current user's untagged records.
// Called by the browser right after import (the "tagging…" marker waits on this),
// and by the cron as a backstop. Cost is flat: ~1 Claude call per 25 records.
//
// GET  -> { untaggedCount }  (lets the UI show the marker state)
// POST -> tags all untagged pending/open records, returns { tagged, untaggedCount }
//         body: { all?: boolean }  — if all, also tags non-pending untagged records.

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  // "Unprocessed" = never run through the tagger (both category AND confidence null).
  // Records the LLM placed have a category; records it couldn't place still have a
  // confidence set, so they count as processed and the marker can reach zero.
  const { count } = await db.from("outreach_records")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("category", null)
    .is("category_confidence", null)
    .neq("status", "resolved")
    .neq("status", "escalated");
  return Response.json({ untaggedCount: count || 0 });
}

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  let body = {};
  try { body = await req.json(); } catch { /* no body is fine */ }

  const categories = await getCategories(user.id);
  if (!categories.length) {
    return Response.json({ tagged: 0, untaggedCount: 0, note: "No categories defined — nothing to tag." });
  }

  // Fetch unprocessed records (never tagged: both category and confidence null).
  // Cap per run to keep within time budget; cron catches the rest.
  const { data: recs, error } = await db.from("outreach_records")
    .select("id, contacts(campaign, issue)")
    .eq("user_id", user.id)
    .is("category", null)
    .is("category_confidence", null)
    .neq("status", "resolved")
    .neq("status", "escalated")
    .limit(200);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const items = (recs || [])
    .map(r => ({ id: r.id, campaign: r.contacts?.campaign, issue: r.contacts?.issue }))
    .filter(it => it.issue);

  if (!items.length) return Response.json({ tagged: 0, untaggedCount: 0 });

  const results = await categorizeIssuesBatch({ items, categories });

  let tagged = 0;
  for (const it of items) {
    const res = results[it.id];
    if (!res) continue;
    const { error: upErr } = await db.from("outreach_records").update({
      category: res.tag, category_confidence: res.confidence,
    }).eq("id", it.id);
    if (!upErr) {
      if (res.tag) await logEvent({ outreachId: it.id, userId: user.id, action: "category_tagged", payload: { category: res.tag, confidence: res.confidence } });
      tagged++;
    }
  }

  // Remaining untagged (records with null category, e.g. ones the LLM couldn't place
  // get tag=null but category_confidence set — we still consider them "processed").
  const { count } = await db.from("outreach_records")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("category", null)
    .is("category_confidence", null)
    .neq("status", "resolved")
    .neq("status", "escalated");

  return Response.json({ tagged, untaggedCount: count || 0 });
}
