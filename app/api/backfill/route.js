import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { categorizeIssuesBatch } from "@/lib/claude";
import { getCategories, getCategoriesDebug } from "@/lib/categories";
import { checkOneRecord } from "@/lib/checker";

export const maxDuration = 300; // up to 5 min on Vercel

// ONE-TIME BACKFILL — run once after the migration, by an admin, from the UI.
// Runs INSIDE your deployed app (uses your app's Supabase service key in its own
// environment). No external access needed.
//
// Two jobs, controlled by body flags so you can run them separately if a run times out:
//   { tag: true }        -> batched category tagging for every untagged record
//   { attribution: true} -> re-run the new relevance-gated reply attribution on every
//                           open record (corrects historical chit-chat false-positives)
//
// GET -> counts so the UI can show what's pending.

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (user.role !== "admin") return Response.json({ error: "Admin only" }, { status: 403 });

  const { count: untagged } = await db.from("outreach_records")
    .select("id", { count: "exact", head: true })
    .is("category", null).is("category_confidence", null)
    .neq("status", "resolved").neq("status", "escalated");

  const { count: checkable } = await db.from("outreach_records")
    .select("id", { count: "exact", head: true })
    .in("status", ["sent", "active", "no_reply", "followup", "stalled", "needs_review"]);

  return Response.json({ untagged: untagged || 0, checkable: checkable || 0 });
}

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (user.role !== "admin") return Response.json({ error: "Admin only" }, { status: 403 });

  let body = {};
  try { body = await req.json(); } catch {}
  const doTag = body.tag !== false;          // default on
  const doAttribution = body.attribution === true; // default off (heavier)
  const limit = body.limit || 150;           // cap per call; UI loops until done

  const result = { tagged: 0, taggedRemaining: 0, checked: 0, checkedRemaining: 0 };

  // ── Job 1: category tagging (all users' records, batched per user) ───────────
  if (doTag) {
    const { data: untagged, error: qErr } = await db.from("outreach_records")
      .select("id, user_id, contacts(campaign, issue)")
      .is("category", null).is("category_confidence", null)
      .neq("status", "resolved").neq("status", "escalated")
      .limit(limit);

    if (qErr) result.tagError = `query failed: ${qErr.message}`;
    result.tagFound = (untagged || []).length;

    const byUser = {};
    for (const r of untagged || []) (byUser[r.user_id] ||= []).push(r);
    for (const [uid, recs] of Object.entries(byUser)) {
      const { categories: cats, debug: catDebug } = await getCategoriesDebug(uid);
      result.catsLoaded = (result.catsLoaded || 0) + cats.length;
      result.catDebug = catDebug;
      if (!cats.length) { result.tagError = `no categories for user ${uid}`; continue; }
      const items = recs.map(r => ({ id: r.id, campaign: r.contacts?.campaign, issue: r.contacts?.issue })).filter(it => it.issue);
      result.itemsWithIssue = (result.itemsWithIssue || 0) + items.length;
      if (!items.length) continue;
      let results;
      try {
        results = await categorizeIssuesBatch({ items, categories: cats });
      } catch (e) {
        result.tagError = `categorize threw: ${e.message}`;
        continue;
      }
      const sample = results[items[0].id];
      result.sampleResult = sample ? JSON.stringify(sample) : "none";
      for (const it of items) {
        const res = results[it.id];
        if (!res) continue;
        const { error } = await db.from("outreach_records").update({ category: res.tag, category_confidence: res.confidence }).eq("id", it.id);
        if (error) { result.updateError = error.message; continue; }
        result.tagged++;
        if (res.tag) await logEvent({ outreachId: it.id, userId: uid, action: "category_tagged", payload: { category: res.tag, confidence: res.confidence, backfill: true } });
      }
    }

    const { count } = await db.from("outreach_records")
      .select("id", { count: "exact", head: true })
      .is("category", null).is("category_confidence", null)
      .neq("status", "resolved").neq("status", "escalated");
    result.taggedRemaining = count || 0;
  }

  // ── Job 2: attribution re-check (re-runs improved logic on open records) ──────
  if (doAttribution) {
    const { data: users } = await db.from("users").select("*");
    const userById = Object.fromEntries((users || []).map(u => [u.id, u]));

    // Process records not re-checked yet in this pass. We mark progress via a flag in
    // message_notes? No — simpler: cap per call and let UI loop; use a marker column.
    const { data: recs } = await db.from("outreach_records")
      .select("*, contacts(*)")
      .in("status", ["sent", "active", "no_reply", "followup", "stalled", "needs_review"])
      .is("backfill_checked", null)
      .limit(limit);

    for (const rec of recs || []) {
      const owner = userById[rec.user_id];
      if (!owner) { await db.from("outreach_records").update({ backfill_checked: true }).eq("id", rec.id); continue; }
      try { await checkOneRecord(rec, owner); }
      catch (e) { console.error("backfill check error:", e.message); }
      await db.from("outreach_records").update({ backfill_checked: true }).eq("id", rec.id);
      result.checked++;
    }

    const { count } = await db.from("outreach_records")
      .select("id", { count: "exact", head: true })
      .in("status", ["sent", "active", "no_reply", "followup", "stalled", "needs_review"])
      .is("backfill_checked", null);
    result.checkedRemaining = count || 0;
  }

  return Response.json({ ok: true, ...result });
}
