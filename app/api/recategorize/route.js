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
//   "all"                     — re-check every record, including already-tagged ones.
//
// Returns full diagnostics (reopened count, items found, categories used, sample
// result, any error) so a "0 categorized" result is explainable instead of a
// dead end — same principle as the backfill/tag-pending diagnostics.

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  let body = {};
  try { body = await req.json(); } catch {}
  const scope = body.scope === "all" ? "all" : "uncategorized";
  const limit = body.limit || 150;

  const diag = { scope, userId: user.id };

  const categories = await getCategories(user.id);
  diag.categoriesLoaded = categories.length;
  diag.categoryTags = categories.map(c => c.tag);
  if (!categories.length) return Response.json({ error: "No categories defined", diag }, { status: 400 });

  // Step 1: re-open eligible records. Use .select("id") on the update so we can
  // report exactly how many rows it actually touched, instead of assuming.
  let reopenQuery = db.from("outreach_records")
    .update({ category_confidence: null, ...(scope === "all" ? { category: null } : {}) })
    .eq("user_id", user.id)
    .neq("status", "resolved").neq("status", "escalated");

  reopenQuery = scope === "all" ? reopenQuery : reopenQuery.is("category", null);
  const { data: reopened, error: reopenErr } = await reopenQuery.select("id");
  if (reopenErr) return Response.json({ error: reopenErr.message, diag }, { status: 500 });
  diag.reopenedCount = (reopened || []).length;

  // Step 2: fetch and tag them now (same batched approach as /api/tag-pending).
  const { data: recs, error } = await db.from("outreach_records")
    .select("id, contacts(campaign, issue)")
    .eq("user_id", user.id)
    .is("category", null).is("category_confidence", null)
    .neq("status", "resolved").neq("status", "escalated")
    .limit(limit);
  if (error) return Response.json({ error: error.message, diag }, { status: 500 });

  diag.recordsFetched = (recs || []).length;
  const items = (recs || []).map(r => ({ id: r.id, campaign: r.contacts?.campaign, issue: r.contacts?.issue })).filter(it => it.issue);
  diag.itemsWithIssue = items.length;

  if (!items.length) return Response.json({ tagged: 0, changed: 0, remaining: 0, diag });

  let results;
  try {
    results = await categorizeIssuesBatch({ items, categories });
  } catch (e) {
    diag.categorizeError = e.message;
    return Response.json({ tagged: 0, changed: 0, remaining: items.length, diag }, { status: 200 });
  }
  diag.sampleResult = results[items[0].id] ? JSON.stringify(results[items[0].id]) : "none";

  let tagged = 0, changed = 0, updateErrorSample = null;
  for (const it of items) {
    const res = results[it.id];
    if (!res) continue;
    const { error: upErr } = await db.from("outreach_records").update({
      category: res.tag, category_confidence: res.confidence,
    }).eq("id", it.id);
    if (upErr) { updateErrorSample = updateErrorSample || upErr.message; continue; }
    tagged++;
    if (res.tag) {
      changed++;
      await logEvent({ outreachId: it.id, userId: user.id, action: "category_tagged", payload: { category: res.tag, confidence: res.confidence, recategorized: true } });
    }
  }
  if (updateErrorSample) diag.updateError = updateErrorSample;

  const { count: remaining } = await db.from("outreach_records")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("category", null).is("category_confidence", null)
    .neq("status", "resolved").neq("status", "escalated");

  return Response.json({ tagged, changed, remaining: remaining || 0, diag });
}
