// Who should be messaged about an issue.
//
// Owner = the DMS campaign_lead. The co_campaign_lead is contacted ONLY as a fallback, when the lead
// cannot be reached (deleted / missing in DMS, no email, or their address bounced); if the co-lead
// cannot be reached either, nobody is messaged and the issue stays in "needs an owner". Two kinds of
// per-issue overrides exist, both created from replies:
//   co_owner       - someone the lead looped in; receives this issue too, in addition to the lead
//   reassigned_to  - the lead disowned it; the new person receives it INSTEAD of the lead
// An override is only valid while the DMS lead is still the person it was created against:
// if the lead changes in DMS, DMS wins and the overrides are ignored.

export function resolveRecipients(issue, overrides = [], redirects = new Map(), people = null) {
  const lead = issue.owner_dms_user_id || null;
  const leadActive = issue.owner_state === 'active';
  const valid = overrides.filter((o) => o.active !== false && o.lead_at_creation === lead);
  const reassigned = valid.filter((o) => o.role === 'reassigned_to').map((o) => o.dms_user_id);
  const coOwners = valid.filter((o) => o.role === 'co_owner').map((o) => o.dms_user_id);
  // Reachable = a known, non-deleted person with an email whose address has not bounced. Without a
  // people map (older callers) only DMS's own active flag is checked, as before.
  const reachable = (id) => {
    if (!people) return true;
    const p = people.get(id);
    return !!p && p.is_deleted !== true && !!p.email && !p.unreachable_at;
  };

  const ids = new Set();
  // A person-level redirect (an unofficial handover) replaces the DMS lead, whatever DMS says.
  const redirectedTo = lead ? redirects.get(lead) : null;
  let base = null;
  if (reassigned.length) reassigned.forEach((id) => ids.add(id));
  else if (redirectedTo) { ids.add(redirectedTo); base = redirectedTo; }
  else if (leadActive && lead) { ids.add(lead); base = lead; }

  // The lead (or whoever took over from them) cannot be reached: try the co-campaign lead instead.
  const coLead = issue.detail?.co_lead_dms_user_id;
  if (!reassigned.length && (!base || !reachable(base)) && coLead && coLead !== lead && reachable(coLead)) {
    ids.delete(base);
    ids.add(coLead);
  }
  coOwners.forEach((id) => ids.add(id));

  return { ownerIds: [...ids], needsOwner: ids.size === 0 };
}
