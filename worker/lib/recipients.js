// Who should be messaged about an issue.
//
// Owner = the DMS campaign_lead only (co_campaign_lead is never contacted). Two kinds of
// per-issue overrides exist, both created from replies:
//   co_owner       - someone the lead looped in; receives this issue too, in addition to the lead
//   reassigned_to  - the lead disowned it; the new person receives it INSTEAD of the lead
// An override is only valid while the DMS lead is still the person it was created against:
// if the lead changes in DMS, DMS wins and the overrides are ignored.

export function resolveRecipients(issue, overrides = []) {
  const lead = issue.owner_dms_user_id || null;
  const leadActive = issue.owner_state === 'active';
  const valid = overrides.filter((o) => o.active !== false && o.lead_at_creation === lead);
  const reassigned = valid.filter((o) => o.role === 'reassigned_to').map((o) => o.dms_user_id);
  const coOwners = valid.filter((o) => o.role === 'co_owner').map((o) => o.dms_user_id);

  const ids = new Set();
  if (reassigned.length) reassigned.forEach((id) => ids.add(id));
  else if (leadActive && lead) ids.add(lead);
  coOwners.forEach((id) => ids.add(id));

  return { ownerIds: [...ids], needsOwner: ids.size === 0 };
}
