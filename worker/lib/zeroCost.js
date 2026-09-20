// Services with zero deliverables AND zero internal cost (methodology note of 21 Aug 2026).
// One issue per campaign x service. Pure helpers here; the Mongo read is in mongoCategories.js.

export const ZERO_COST_SERVICES = {
  'cba00310-2ab9-4c46-9b43-19dda6818c67': 'Content Creation / Illustration Work',
  'cff61057-86a9-4dbc-968f-ee7be97fcf1e': 'ORM',
  '5f79b5f3-ab89-42d0-a0f5-cc68700a03de': 'Twitter Trend',
  'b7660187-6bd4-4477-af1e-f970ee74bec4': 'Offline Activity',
};

const DID = '(?:done|made|created|produced|executed|delivered|handled)';
// "made by internal designer team", "created by our team", "done by our own AI team", "done internally"
const EXCLUDE = [
  new RegExp(`\\b${DID}\\b[^.\\n]{0,60}?\\b(?:by|via|through|from)\\b[^.\\n]{0,25}?\\b(?:internal|our|in-?house)\\b`, 'i'),
  new RegExp(`\\b${DID}\\s+(?:internally|in-?house)\\b`, 'i'),
  new RegExp(`\\b(?:internal|in-?house|our)\\b[^.\\n]{0,40}?\\bteam\\b[^.\\n]{0,30}?\\b(?:${DID}|did)\\b`, 'i'),
];
const AI = /\bai\b|artificial intelligence|ai-generated|gen ?ai/i;

/**
 * 'exclude' = clear statement that the internal/our/in-house team did the work (no nudge at all)
 * 'manual'  = AI mentioned without such a statement, or a Chiraiya campaign (a person checks; no nudge)
 * 'action'  = everything else (nudge)
 * A note that merely exists does NOT exclude a campaign.
 */
export function classifyNote(note, campaignName = '') {
  const text = String(note || '').replace(/\s+/g, ' ').trim();
  if (EXCLUDE.some((re) => re.test(text))) return 'exclude';
  if (/chiraiya/i.test(campaignName) || AI.test(text)) return 'manual';
  return 'action';
}

/** Aggregation over campaign_services (see the methodology note). One row per campaign x service. */
export function zeroCostPipeline() {
  return [
    { $match: { service_id: { $in: Object.keys(ZERO_COST_SERVICES) } } },
    { $group: { _id: { c: '$campaign_id', s: '$service_id' }, deliv: { $sum: { $ifNull: ['$deliverables', 0] } }, cost: { $sum: { $ifNull: ['$total_internal_cost', 0] } }, notes: { $push: { $ifNull: ['$internal_note', ''] } } } },
    { $lookup: {
      from: 'campaign_services_plans',
      let: { c: '$_id.c', s: '$_id.s' },
      pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$campaign_id', '$$c'] }, { $eq: ['$service_id', '$$s'] }] } } },
        { $group: { _id: null, deliv: { $sum: { $ifNull: ['$deliverables', 0] } }, cost: { $sum: { $multiply: [{ $ifNull: ['$deliverables', 0] }, { $ifNull: ['$internal_cost_per_deliverable', 0] }] } } } },
      ],
      as: 'plan',
    } },
    // Plan rows win over the service summary; any plan deliverable above zero removes the row.
    { $addFields: { hasPlan: { $gt: [{ $size: '$plan' }, 0] } } },
    { $addFields: { effDeliv: { $cond: ['$hasPlan', { $first: '$plan.deliv' }, '$deliv'] }, effCost: { $cond: ['$hasPlan', { $first: '$plan.cost' }, '$cost'] } } },
    { $match: { effDeliv: 0, effCost: 0 } },
    { $project: { _id: 0, campaign_id: '$_id.c', service_id: '$_id.s', notes: 1 } },
  ];
}

/**
 * Rows -> { issues, review, excluded } after the status/client filters, the note rules and the owner's own decisions.
 * decisions: Map "campaign_id|service_id" -> 'exclude' | 'nudge'  (the owner's decision always wins over the note rules)
 * No model is involved anywhere here: every sync re-evaluates the rows from scratch with these fixed rules, at no cost.
 */
export function classifyZeroCost(rows, campaignById, clientNameById, decisions = new Map()) {
  const issues = [];
  const review = [];
  const excluded = [];
  for (const r of rows) {
    const campaign = campaignById.get(r.campaign_id);
    if (!campaign || !['Complete', 'Active'].includes(campaign.campaign_status)) continue;
    if (/^\s*test client\s*$/i.test(clientNameById.get(campaign.client_id) || '')) continue;
    const note = (r.notes || []).filter(Boolean).join(' | ');
    const service = ZERO_COST_SERVICES[r.service_id];
    const row = { campaign, service, service_id: r.service_id, note };
    const decision = decisions.get(`${r.campaign_id}|${r.service_id}`);
    if (decision === 'exclude') { excluded.push({ ...row, why: 'owner decision' }); continue; }
    if (decision === 'nudge') { issues.push(row); continue; }
    const verdict = classifyNote(note, campaign.name);
    if (verdict === 'exclude') { excluded.push({ ...row, why: 'note says the internal team did it' }); continue; }
    if (verdict === 'manual') { review.push(row); continue; }
    issues.push(row);
  }
  return { issues, review, excluded };
}
