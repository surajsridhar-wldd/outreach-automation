import { db } from "./supabase";

// Fetch the category list available to a user (their own + org-wide NULL-user rows).
export async function getCategories(userId) {
  const { data, error } = await db
    .from("categories")
    .select("*")
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order("name", { ascending: true });
  if (error) { console.error("getCategories error:", error.message); return []; }
  return data || [];
}
