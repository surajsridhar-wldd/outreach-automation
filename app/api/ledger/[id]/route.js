import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

// Everything known about one issue: who was messaged when, what they replied and how it was read, holds and owners.
export async function GET(_req, { params }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (user.role !== "admin") return Response.json({ error: "Admin only" }, { status: 403 });
  const id = params.id;
  const { data: issue } = await db.from("issues").select("*").eq("id", id).single();
  if (!issue) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: msgItems } = await db.from("message_items").select("message_out_id,item_no,nudge_no").eq("issue_id", id);
  const outIds = (msgItems || []).map((i) => i.message_out_id);
  const [messages, interps, owners, review, items] = await Promise.all([
    outIds.length ? db.from("messages_out").select("id,channel,kind,status,mode,to_address,cc_addresses,subject,sent_at,created_at,error").in("id", outIds).order("created_at", { ascending: true }) : { data: [] },
    db.from("interpretations").select("id,intent,promised_date,target_text,evidence,confidence,needs_review,created_at,messages_in(sender_address,received_at,clean_text)").eq("issue_id", id).order("created_at", { ascending: true }),
    db.from("issue_owners").select("id,dms_user_id,role,active,created_at").eq("issue_id", id),
    db.from("review_items").select("id,kind,note,status,created_at").eq("issue_id", id).order("created_at", { ascending: false }),
    db.from("issue_items").select("id,item_key,item_created_at,first_seen_at,nudge_count,last_nudged_at,state").eq("issue_id", id).order("first_seen_at", { ascending: true }),
  ]);
  const ids = [issue.owner_dms_user_id, ...(owners.data || []).map((o) => o.dms_user_id)].filter(Boolean);
  const { data: people } = ids.length ? await db.from("dms_people").select("dms_user_id,name,email,manager_email,manager_name").in("dms_user_id", ids) : { data: [] };
  return Response.json({ issue, messages: messages.data || [], replies: interps.data || [], owners: owners.data || [], review: review.data || [], items: items.data || [], people: people || [] });
}
