import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { categorizeIssuesBatch } from "@/lib/claude";
import { getCategories } from "@/lib/categories";

export const maxDuration = 120;

// RE-CATEGORIZE — for when a category is added/edited AFTER records were already
// tagged. Once a record is tagged (or the tagger decided nothing fit), it's marked
// "processed" via category_confidence and the normal tagging flow never revisits it
// — even if a brand-new category would now be a perfect fit. This endpoint explicitly
// re-opens records and re-runs them against the CURRENT full category list.
//
// scope:
//   "uncategorized" (default) — only records with no category (tag was null last time).
//                                Cheapest, matches the common case: you added a new
//                                category and want the "doesn't fit anything" pile
//                                re-checked against it.
//   "all"                     — re-check every record, including ones that already
//                                have a category (in case a category's description
//                                changed enough to change the right answer). Heavier.

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  let body = {};
  try { body = await req.json(); } catch {}
  const scope = body.scope === "all" ? "all" : "uncategorized";
  const limit = body.limit || 150;

  const categories = await getCategories(user.id);
  if (!categories.length) return Response.json({ error: "No categories defined" }, { status: 400 });

  // Step 1: re-open eligible records by clearing category_confidence (and category,
  // for the "all" scope) so the normal tagging query would pick them up again.
  let reopenQuery = db.from("outreach_records")
    .update({ category_confidence: null, ...(scope === "all" ? { category: null } : {}) })
    .eq("user_id", user.id)
    .neq("status", "resolved").neq("status", "escalated");

  reopenQuery = scope === "all" ? reopenQuery : reopenQuery.is("category", null);
  const { error: reopenErr } = await reopenQuery;
  if (reopenErr) return Response.json({ error: reopenErr.message }, { status: 500 });

  // Step 2: fetch and tag them now (same batched approach as /api/tag-pending).
  const { data: recs, error } = await db.from("outreach_records")
    .select("id, contacts(campaign, issue)")
    .eq("user_id", user.id)
    .is("category", null).is("category_confidence", null)
    .neq("status", "resolved").neq("status", "escalated")
    .limit(limit);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const items = (recs || []).map(r => ({ id: r.id, campaign: r.contacts?.campaign, issue: r.contacts?.issue })).filter(it => it.issue);
  if (!items.length) return Response.json({ tagged: 0, changed: 0, remaining: 0 });

  const results = await categorizeIssuesBatch({ items, categories });

  let tagged = 0, changed = 0;
  for (const it of items) {
    const res = results[it.id];
    if (!res) continue;
    const { error: upErr } = await db.from("outreach_records").update({
      category: res.tag, category_confidence: res.confidence,
    }).eq("id", it.id);
    if (!upErr) {
      tagged++;
      if (res.tag) {
        changed++;
        await logEvent({ outreachId: it.id, userId: user.id, action: "category_tagged", payload: { category: res.tag, confidence: res.confidence, recategorized: true } });
      }
    }
  }

  const { count: remaining } = await db.from("outreach_records")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("category", null).is("category_confidence", null)
    .neq("status", "resolved").neq("status", "escalated");

  return Response.json({ tagged, changed, remaining: remaining || 0 });
}
