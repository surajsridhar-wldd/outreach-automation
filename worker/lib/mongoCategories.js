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
    { $group: { _id: { campaign_id: '$sub.campaign_id', invoice_id: '$invoice_id' } } },
    { $group: { _id: '$_id.campaign_id', item_count: { $sum: 1 } } },
  ];
}

/**
 * Submitted creator links awaiting approval. `submitted_at` must be a real date: legacy rows that
 * carry a link but were never formally submitted are not pending work (8 such rows at check time).
 */
export function creatorSubmissionPipeline() {
  return [
    { $match: { approved: 0, url: { $type: 'string', $regex: '\\S' }, submitted_at: { $type: 'date' } } },
    { $group: { _id: '$campaign_id', item_count: { $sum: 1 } } },
  ];
}

/** Screenshot approvals: only an explicit 0 is pending (null/missing/other values are not). */
export function screenshotApprovalPipeline() {
  return [
    { $match: { latest_screenshot_status: 0 } },
    { $group: { _id: '$campaign_id', item_count: { $sum: 1 } } },
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
export async function fetchOpenIssues(db, now = new Date(), { log } = {}) {
  const today = utcDate(now);
  const perCampaignCounts = {
    [CATEGORY.INVOICE]: await db.collection('invoices').aggregate(invoiceApprovalPipeline()).toArray(),
    [CATEGORY.CREATOR]: await db.collection('creator_submissions').aggregate(creatorSubmissionPipeline()).toArray(),
    [CATEGORY.SCREENSHOT]: await aggregateWithFallback(
      db.collection('creator_submissions'), screenshotApprovalPipeline(), { hint: SCREENSHOT_INDEX_HINT }, log),
  };

  const campaignDocs = new Map();
  const remember = (docs) => docs.forEach((c) => campaignDocs.set(c.campaign_id, c));

  const closings = await db.collection('campaigns').find(closingFilter(now), { projection: CAMPAIGN_PROJECTION }).toArray();
  const proposals = await db.collection('campaigns').find(proposalFilter(now), { projection: CAMPAIGN_PROJECTION }).toArray();
  remember(closings);
  remember(proposals);

  const missingIds = [...new Set(Object.values(perCampaignCounts).flat().map((r) => r._id))]
    .filter((id) => id && !campaignDocs.has(id));
  if (missingIds.length) {
    remember(await db.collection('campaigns')
      .find({ campaign_id: { $in: missingIds } }, { projection: CAMPAIGN_PROJECTION }).toArray());
  }

  const leadIds = [...new Set([...campaignDocs.values()].map((c) => c.campaign_lead).filter(Boolean))];
  const users = leadIds.length
    ? await db.collection('users').find({ id: { $in: leadIds } }, { projection: { _id: 0, id: 1, name: 1, email: 1, is_deleted: 1 } }).toArray()
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  const ownerInfo = (campaign) => {
    const u = userById.get(campaign.campaign_lead);
    // Only an explicit is_deleted === false counts as an active account.
    const state = !campaign.campaign_lead || !u ? 'missing' : u.is_deleted === false ? 'active' : 'deleted';
    return { owner_dms_user_id: campaign.campaign_lead || null, owner_state: state, owner_name: u?.name ?? null, owner_email: u?.email ?? null };
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
      issues.push(base(category, campaign, row.item_count, {}));
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

  return { issues, orphans };
}
