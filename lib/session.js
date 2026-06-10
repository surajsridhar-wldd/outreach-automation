import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { db } from "./supabase";

const sessionOptions = {
  password: process.env.SESSION_SECRET,
  cookieName: "outreach_session",
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
};

export async function getSession() {
  return getIronSession(cookies(), sessionOptions);
}

// Returns the full user row, or null if not signed in
export async function requireUser() {
  const session = await getSession();
  if (!session.userId) return null;
  const { data } = await db.from("users").select("*").eq("id", session.userId).single();
  return data || null;
}

export function unauthorized() {
  return Response.json({ error: "Not signed in" }, { status: 401 });
}
