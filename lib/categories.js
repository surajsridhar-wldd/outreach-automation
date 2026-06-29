import { db } from "./supabase";

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY SCOPING DECISION (2026-06-27) — ORG-WIDE for now.
//
// Categories are currently ORG-WIDE: seeded with user_id = NULL and visible to
// every user. All admins share one category list and one set of reconciliation
// buckets. This fits a team working the same standard problem types.
//
// FUTURE: if categories should become PER-USER (each admin has their own private
// list), the change is:
//   1. Seed/create categories with the owner's user_id instead of NULL.
//   2. In getCategories below, return ONLY `user_id.eq.${userId}` (drop the
//      `,user_id.is.null` OR clause).
//   3. In /api/categories POST, it already writes user_id = user.id, so per-user
//      creation already works — only the read scope and seed need changing.
// Suraj: tell Claude "make categories per-user" and point here when that day comes.
// ─────────────────────────────────────────────────────────────────────────────

// Fetch the category list available to a user. Org-wide (NULL user_id) rows are
// shared by everyone; a user's own rows (if any) are also included so the system
// keeps working if/when per-user categories are introduced later.
//
// NOTE: we deliberately do NOT use a PostgREST .or() string mixing `user_id.eq.<uuid>`
// with `user_id.is.null` — that combination returned empty/errored against UUID
// columns. Instead we fetch all and filter in JS, which is tiny (a handful of rows)
// and completely reliable.
export async function getCategories(userId) {
  const { data, error } = await db
    .from("categories")
    .select("*")
    .order("name", { ascending: true });
  if (error) { console.error("getCategories error:", error.message); return []; }
  return (data || []).filter(c => c.user_id == null || String(c.user_id) === String(userId));
}
