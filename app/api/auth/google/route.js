import { googleAuthUrl } from "@/lib/gmail";
import { requireUser, unauthorized } from "@/lib/session";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  return Response.redirect(googleAuthUrl());
}
