// Bring the `issues` table in line with what Mongo says right now.
//
// diffIssues is pure and tested. A category that loses most of its open issues in one go is
// still cleared in full (Mongo is the sole source of truth: not flagged there means not
// pending anywhere) - `suspectCategories` is kept only as a same-run audit note for anything
// unusually large, never as a block on clearing or a manual-approval gate (owner decision,
// 2026-09-25: after repeatedly confirming these mass-clears were correct, the guard was
// changed from blocking to informational-only).

const keyOf = (x) => `${x.category}::${x.campaign_id}`;

export function diffIssues(existingOpen, fetched, { guardMinOpen = 10, guardDropRatio = 0.5 } = {}) {
  const existingByKey = new Map(existingOpen.map((e) => [keyOf(e), e]));
  const fetchedKeys = new Set(fetched.map(keyOf));

  const toInsert = [];
  const toUpdate = [];
  for (const f of fetched) {
    const e = existingByKey.get(keyOf(f));
    if (e) toUpdate.push({ id: e.id, ...f });
    else toInsert.push(f);
  }

  const byCategory = new Map();
  for (const e of existingOpen) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, []);
    byCategory.get(e.category).push(e);
  }

  const toClear = [];
  const suspectCategories = [];
  for (const [category, rows] of byCategory) {
    const gone = rows.filter((r) => !fetchedKeys.has(keyOf(r)));
    if (rows.length >= guardMinOpen && gone.length / rows.length > guardDropRatio) {
      suspectCategories.push({ category, wasOpen: rows.length, wouldClear: gone.length });
    }
    toClear.push(...gone);
  }
  return { toInsert, toUpdate, toClear, suspectCategories };
}

/** Distinct owners seen in this read, for the dms_people table. */
export function peopleFromIssues(fetched) {
  const byId = new Map();
  for (const f of fetched) {
    if (!f.owner_dms_user_id || byId.has(f.owner_dms_user_id)) continue;
    byId.set(f.owner_dms_user_id, {
      dms_user_id: f.owner_dms_user_id,
      name: f.owner_name,
      email: f.owner_email,
      is_deleted: f.owner_state === 'deleted' ? true : f.owner_state === 'active' ? false : null,
      manager_email: f.owner_manager_email ?? null,
      manager_name: f.owner_manager_name ?? null,
      manager_source: f.owner_manager_source ?? null,
    });
  }
  return [...byId.values()];
}
