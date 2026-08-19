// Template-first messaging. Uses plain ASCII in subjects to avoid encoding issues.

export function outreachSubject(c) {
  const campaign = c.campaign ? `${c.campaign} - ` : "";
  return `[Action Required] ${campaign}data correction needed`;
}

export function outreachBody(c, senderName) {
  return `Hi ${c.name},

As part of ${c.campaign || "our ongoing data quality work"}, we found an issue that needs your action:

${c.issue}

Could you please take the necessary corrective action and reply to confirm once done? If something is unclear or you believe this is not yours to fix, reply and let me know.

Thanks,
${senderName}`;
}

export function followupBody(c, senderName, n) {
  const tone = n >= 3
    ? "This is now urgent - the correction is blocking downstream work."
    : n === 2
    ? "Bumping this again as we haven't heard back."
    : "Just following up on the below - could you give me an update?";
  return `Hi ${c.name},

${tone}

Original issue (${c.campaign || "data correction"}):
${c.issue}

Please reply with a status or confirm once actioned.

Thanks,
${senderName}`;
}

export function slackOutreach(c, senderName) {
  return `Hi ${c.name} :wave: - as part of *${c.campaign || "our data quality work"}*, we found an issue that needs your action:\n\n> ${c.issue}\n\nCould you take the corrective action and reply here to confirm once done? Thanks!`;
}

export function slackFollowup(c, n) {
  const tone = n >= 3 ? ":rotating_light: This is now urgent -" : n === 2 ? "Bumping this again -" : "Following up -";
  return `${tone} any update on this?\n\n> *${c.campaign || "Data correction"}*: ${c.issue}\n\nPlease reply with a status or confirm once actioned.`;
}

// ── Bundled outreach (multiple issues, one message) ────────────────────────────
// Used when several pending records for the SAME person are sent together. Groups
// by campaign so each issue is still clearly delineated, but only one message goes
// out instead of one per issue.

export function bundledOutreachSubject(name, count) {
  return `[Action Required] ${count} data correction items need your attention`;
}

export function bundledOutreachBody(name, items, senderName) {
  // items: [{ campaign, issue }]
  const byCampaign = items.map((it, i) =>
    `${i + 1}. ${it.campaign ? `${it.campaign}: ` : ""}${it.issue}`
  ).join("\n\n");
  return `Hi ${name},

We found ${items.length} items across your campaigns that need your action:

${byCampaign}

Could you please take the necessary corrective action on each and reply to confirm once done? If any of these aren't yours to fix, reply and let me know which.

Thanks,
${senderName}`;
}

export function slackBundledOutreach(name, items, senderName) {
  const byCampaign = items.map((it, i) =>
    `${i + 1}. ${it.campaign ? `*${it.campaign}*: ` : ""}${it.issue}`
  ).join("\n");
  return `Hi ${name} :wave: - we found *${items.length} items* across your campaigns that need your action:\n\n${byCampaign}\n\nCould you take the corrective action on each and reply here to confirm once done? Thanks!`;
}
