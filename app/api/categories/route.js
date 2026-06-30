import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";
import { getCategories, getCategoriesDebug } from "@/lib/categories";

export async function GET(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  if (url.searchParams.get("debug") === "1") {
    const { categories, debug } = await getCategoriesDebug(user.id);
    return Response.json({ categories, debug, userId: user.id });
  }
  const categories = await getCategories(user.id);
  return Response.json({ categories });
}

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { tag, name, description, done_definition, is_time_sensitive } = await req.json();
  if (!tag || !name) return Response.json({ error: "tag and name are required" }, { status: 400 });
  const cleanTag = String(tag).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const { data, error } = await db.from("categories").insert({
    user_id: user.id, tag: cleanTag, name,
    description: description || null, done_definition: done_definition || null,
    is_time_sensitive: !!is_time_sensitive,
  }).select().single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ category: data });
}

export async function PATCH(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id, ...fields } = await req.json();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const allowed = {};
  for (const k of ["name", "description", "done_definition", "is_time_sensitive"]) {
    if (k in fields) allowed[k] = fields[k];
  }
  const { error } = await db.from("categories").update(allowed).eq("id", id).eq("user_id", user.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

export async function DELETE(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await req.json();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const { error } = await db.from("categories").delete().eq("id", id).eq("user_id", user.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
