import { slackAuthUrl } from "@/lib/slack";
export async function GET() {
  return Response.redirect(slackAuthUrl());
}
