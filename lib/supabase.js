import { createClient } from "@supabase/supabase-js";

export const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export async function logEvent({ outreachId, userId, action, prevStatus = null, newStatus = null, payload = null }) {
  await db.from("outreach_history").insert({
    outreach_id: outreachId,
    user_id: userId,
    action,
    prev_status: prevStatus,
    new_status: newStatus,
    payload,
  });
}
