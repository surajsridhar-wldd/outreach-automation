// The five automated categories, defined against the live DMS database (MongoDB, READ-ONLY).
//
// Every definition below was cross-checked against the counts and per-campaign CSVs the
// owner exported from the DMS on 2026-09-19:
//   invoice approvals 14 | creator submissions 64 | screenshot approvals 117/118 |
//   pending closings 60 | pending proposals 84.
//
// Nothing here writes to Mongo. Owner = campaigns.campaign_lead only (co_campaign_lead is
// deliberately ignored).

import { addDays, daysBetween, utcDate } from './time.js';
import { CATEGORY } from './planner.js';
import { zeroCostPipeline, classifyZeroCost, ZERO_COST_SERVICES } from './zeroCost.js';

/** Mongo dates are compared on their UTC calendar date, which is how the owner's lists were built. */
export function endOfUtcDay(dateStr) {
  return new Date(`${dateStr}T23:59:59.999Z`);
}

export function cutoffs(now = new Date()) {
  const today = utcDate(now);
  return {
    today,
    // Posting ended at least 7 days ago.
    closingEnd: endOfUtcDay(addDays(today, -7)),
    // In Proposal for MORE than 14 days (created 15+ days ago).
    proposalCreated: endOfUtcDay(addDays(today, -15)),
  };
}

// Statuses that count as "still open" for a closing. On Hold / Complete / Cancel do not.
export const CLOSING_STATUSES = ['Active', 'Approved'];
export const PROPOSAL_STATUS = 'Proposal';

/** invoices.invoice_status = -2 means "awaiting campaign lead approval". One count per invoice per campaign. */
export function invoiceApprovalPipeline() {
  // Starts from the (small) set of pending invoices instead of scanning all submissions.
  return [
    { $match: { invoice_status: -2 } },
    { $lookup: { from: 'invoice_submission_maps', localField: 'invoice_id', foreignField: 'invoice_id', as: 'maps' } },
    { $unwind: '$maps' },
    { $lookup: { from: 'submissions', localField: 'maps.submission_id', foreignField: 'submission_id', as: 'sub' } },
    { $unwind: '$sub' },
    { $group: { _id: { campaign_id: '$sub.campaign_id', invoice_id: '$invoice_id' }, at: { $first: '$createdAt' } } },
    { $group: { _id: '$_id.campaign_id', item_count: { $sum: 1 }, items: { $push: { key: '$_id.invoice_id', at: '$at' } } } },
  ];
}

/**
 * Submitted creator links awaiting approval. `submitted_at` must be a real date: legacy rows that
 * carry a link but were never formally submitted are not pending work (8 such rows at check time).
 */
export function creatorSubmissionPipeline() {
  return [
    { $match: { approved: 0, url: { $type: 'string', $regex: '\\S' }, submitted_at: { $type: 'date' } } },
    { $group: { _id: '$campaign_id', item_count: { $sum: 1 }, items: { $push: { key: '$submission_id', at: '$submitted_at' } } } },
  ];
}

/** Screenshot approvals: only an explicit 0 is pending (null/missing/other values are not). */
export function screenshotApprovalPipeline() {
  return [
    { $match: { latest_screenshot_status: 0 } },
    { $group: { _id: '$campaign_id', item_count: { $sum: 1 }, items: { $push: { key: '$submission_id', at: null } } } },
  ];
}

// Index that lets Mongo answer the screenshot count from the index alone instead of scanning the
// whole (~770 MB) collection. If it is ever renamed the query falls back to a normal scan.
export const SCREENSHOT_INDEX_HINT = 'campaign_id_1_category_id_1_approved_1_latest_screenshot_status_1';

export function closingFilter(now = new Date()) {
  return { campaign_status: { $in: CLOSING_STATUSES }, posting_end_date: { $type: 'date', $lte: cutoffs(now).closingEnd } };
}

export function proposalFilter(now = new Date()) {
  return { campaign_status: PROPOSAL_STATUS, createdAt: { $lte: cutoffs(now).proposalCreated } };
}

/**
 * The reporting manager, from DMS: the person's cohort lead, else their pod lead. A lead only counts if
 * they are an active company account and not the person themselves (leads have no one above them here).
 */
export function resolveManager(user, cohortLeadId, podLeadId, usersById) {
  const usable = (m) => m && m.is_deleted === false && m.id !== user.id && /^[^@\s]+@wldd\.in$/i.test(m.email || '');
  const cohort = usersById.get(cohortLeadId);
  if (usable(cohort)) return { manager_dms_user_id: cohort.id, manager_name: cohort.name, manager_email: cohort.email, manager_source: 'cohort' };
  const pod = usersById.get(podLeadId);
  if (usable(pod)) return { manager_dms_user_id: pod.id, manager_name: pod.name, manager_email: pod.email, manager_source: 'pod' };
  return { manager_dms_user_id: null, manager_name: null, manager_email: null, manager_source: null };
}

const CAMPAIGN_PROJECTION = {
  _id: 0, campaign_id: 1, name: 1, campaign_status: 1, campaign_lead: 1,
  posting_end_date: 1, createdAt: 1, client_id: 1, actual_cohort: 1, actual_pod: 1,
};

async function aggregateWithFallback(collection, pipeline, options, log) {
  try {
    return await collection.aggregate(pipeline, options).toArray();
  } catch (err) {
    if (options?.hint) {
      log?.(`hint ${options.hint} failed (${err.message}); retrying without it`);
      return collection.aggregate(pipeline).toArray();
    }
    throw err;
  }
}

/**
 * Read all open issues for the five categories.
 * Returns { issues, orphans }:
 *   issues  - one row per (category, campaign) that is pending, with owner state resolved
 *   orphans - pending rows whose campaign no longer exists (cannot be attributed to anyone)
 */
export async function fetchOpenIssues(db, now = new Date(), { log, zeroDecisions = new Map() } = {}) {
  const today = utcDate(now);
  const perCampaignCounts = {
    [CATEGORY.INVOICE]: await db.collection('invoices').aggregate(invoiceApprovalPipeline()).toArray(),
    [CATEGORY.CREATOR]: await db.collection('creator_submissions').aggregate(creatorSubmissionPipeline()).toArray(),
    [CATEGORY.SCREENSHOT]: await aggregateWithFallback(
      db.collection('creator_submissions'), screenshotApprovalPipeline(), { hint: SCREENSHOT_INDEX_HINT }, log),
  };

  // A screenshot item is one UPLOAD: a new upload for the same submission is a new item with a fresh count.
  const shotRows = perCampaignCounts[CATEGORY.SCREENSHOT] || [];
  const submissionIds = [...new Set(shotRows.flatMap((r) => (r.items || []).map((x) => x.key)).filter(Boolean))];
  if (submissionIds.length) {
    const latest = new Map();
    const docs = await db.collection('deliverable_screenshots').find({ submission_id: { $in: submissionIds } }, { projection: { submission_id: 1, createdAt: 1 } }).sort({ createdAt: -1 }).toArray();
    for (const d of docs) if (!latest.has(d.submission_id)) latest.set(d.submission_id, d);
    for (const r of shotRows) {
      r.items = (r.items || []).map((x) => { const d = latest.get(x.key); return { key: d ? `${x.key}:${String(d._id)}` : `${x.key}:none`, at: d?.createdAt ?? null }; });
    }
  }

  const campaignDocs = new Map();
  const remember = (docs) => docs.forEach((c) => campaignDocs.set(c.campaign_id, c));

  const closings = await db.collection('campaigns').find(closingFilter(now), { projection: CAMPAIGN_PROJECTION }).toArray();
  const proposals = await db.collection('campaigns').find(proposalFilter(now), { projection: CAMPAIGN_PROJECTION }).toArray();
  remember(closings);
  remember(proposals);

  // Zero-cost services: one row per campaign x service that passes the methodology's tests.
  const zeroRows = await db.collection('campaign_services').aggregate(zeroCostPipeline()).toArray();
  const zeroCampaignIds = [...new Set(zeroRows.map((r) => r.campaign_id))];
  const zeroCampaigns = zeroCampaignIds.length
    ? await db.collection('campaigns').find({ campaign_id: { $in: zeroCampaignIds } }, { projection: CAMPAIGN_PROJECTION }).toArray() : [];
  remember(zeroCampaigns);
  const clientIds = [...new Set(zeroCampaigns.map((c) => c.client_id).filter(Boolean))];
  const clientRows = clientIds.length ? await db.collection('clients').find({ client_id: { $in: clientIds } }, { projection: { _id: 0, client_id: 1, name: 1 } }).toArray() : [];
  const zero = classifyZeroCost(zeroRows, new Map(zeroCampaigns.map((c) => [c.campaign_id, c])), new Map(clientRows.map((c) => [c.client_id, c.name])), zeroDecisions);

  const missingIds = [...new Set(Object.values(perCampaignCounts).flat().map((r) => r._id))]
    .filter((id) => id && !campaignDocs.has(id));
  if (missingIds.length) {
    remember(await db.collection('campaigns')
      .find({ campaign_id: { $in: missingIds } }, { projection: CAMPAIGN_PROJECTION }).toArray());
  }

  const leadIds = [...new Set([...campaignDocs.values()].map((c) => c.campaign_lead).filter(Boolean))];
  const USER_PROJECTION = { _id: 0, id: 1, name: 1, email: 1, is_deleted: 1, cohort_id: 1, pod_id: 1 };
  const users = leadIds.length ? await db.collection('users').find({ id: { $in: leadIds } }, { projection: USER_PROJECTION }).toArray() : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  // Reporting lines (cohort lead, else pod lead) for the people we will message.
  const cohortIds = [...new Set(users.map((u) => u.cohort_id).filter(Boolean))];
  const podIds = [...new Set(users.map((u) => u.pod_id).filter(Boolean))];
  const cohorts = cohortIds.length ? await db.collection('cohorts').find({ cohort_id: { $in: cohortIds } }, { projection: { _id: 0, cohort_id: 1, cohort_lead_id: 1 } }).toArray() : [];
  const pods = podIds.length ? await db.collection('pods').find({ pod_id: { $in: podIds } }, { projection: { _id: 0, pod_id: 1, pod_lead_id: 1 } }).toArray() : [];
  const cohortLeadOf = new Map(cohorts.map((c) => [c.cohort_id, c.cohort_lead_id]));
  const podLeadOf = new Map(pods.map((p) => [p.pod_id, p.pod_lead_id]));
  const managerIds = [...new Set([...cohortLeadOf.values(), ...podLeadOf.values()].filter(Boolean))];
  const managerUsers = managerIds.length ? await db.collection('users').find({ id: { $in: managerIds } }, { projection: USER_PROJECTION }).toArray() : [];
  const managersById = new Map(managerUsers.map((u) => [u.id, u]));

  const ownerInfo = (campaign) => {
    const u = userById.get(campaign.campaign_lead);
    // Only an explicit is_deleted === false counts as an active account.
    const state = !campaign.campaign_lead || !u ? 'missing' : u.is_deleted === false ? 'active' : 'deleted';
    const mgr = u ? resolveManager(u, cohortLeadOf.get(u.cohort_id), podLeadOf.get(u.pod_id), managersById)
      : { manager_dms_user_id: null, manager_name: null, manager_email: null, manager_source: null };
    return {
      owner_dms_user_id: campaign.campaign_lead || null, owner_state: state, owner_name: u?.name ?? null, owner_email: u?.email ?? null,
      owner_manager_id: mgr.manager_dms_user_id, owner_manager_name: mgr.manager_name, owner_manager_email: mgr.manager_email, owner_manager_source: mgr.manager_source,
    };
  };

  const base = (category, campaign, item_count, detail) => ({
    category,
    campaign_id: campaign.campaign_id,
    campaign_name: campaign.name,
    campaign_status: campaign.campaign_status,
    item_count,
    detail,
    ...ownerInfo(campaign),
  });

  const issues = [];
  const orphans = [];

  for (const [category, rows] of Object.entries(perCampaignCounts)) {
    for (const row of rows) {
      const campaign = campaignDocs.get(row._id);
      if (!campaign) { orphans.push({ category, campaign_id: row._id, item_count: row.item_count }); continue; }
      issues.push({ ...base(category, campaign, row.item_count, {}), items: (row.items || []).map((x) => ({ key: String(x.key), at: x.at ? new Date(x.at).toISOString() : null })) });
    }
  }
  for (const c of closings) {
    issues.push(base(CATEGORY.CLOSING, c, 1, {
      posting_end_date: c.posting_end_date.toISOString(),
      overdue_days: daysBetween(utcDate(c.posting_end_date), today),
    }));
  }
  for (const c of proposals) {
    issues.push(base(CATEGORY.PROPOSAL, c, 1, {
      created_at: c.createdAt.toISOString(),
      pending_days: daysBetween(utcDate(c.createdAt), today),
    }));
  }

  // One issue per campaign x service: the id carries the service so two services on one campaign stay separate.
  for (const z of zero.issues) {
    issues.push({ ...base(CATEGORY.ZERO_COST, z.campaign, 1, { service: z.service, internal_note: z.note.slice(0, 300) }), campaign_id: `${z.campaign.campaign_id}|${z.service_id}` });
  }
  // AI-only notes and Chiraiya campaigns go to a person, not to a nudge.
  const manualVerify = zero.review.map((z) => ({ key: z.key, reason: z.reason, campaign_id: z.campaign.campaign_id, service_id: z.service_id, campaign_name: z.campaign.name, service: z.service, note: z.note.slice(0, 200) }));
  const zeroExcluded = zero.excluded.map((z) => ({ campaign_id: z.campaign.campaign_id, service_id: z.service_id, campaign_name: z.campaign.name, service: z.service, note: z.note.slice(0, 200), why: z.why }));

  return { issues, orphans, manualVerify, zeroExcluded };
}
