// Shared matching engine — one place for deciding "is this incoming row the same
// as an existing record?" Used by import dedup, reconciliation, and (indirectly)
// reply attribution. Replaces the brittle exact-string comparisons that caused
// re-imports to send duplicate messages instead of being recognized as the same record.

// Normalize a free-text field for tolerant comparison:
// - lowercase
// - collapse all whitespace runs to a single space
// - normalize dash variants (–, —, -) to a plain hyphen, then strip spaces AROUND hyphens
//   so "One8 x WLDD- Event" and "One8 x WLDD - Event" and "One8 xWLDD-Event" converge
// - strip leading/trailing punctuation/space
export function norm(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-") // unicode dashes -> hyphen
    .replace(/\s*-\s*/g, "-")               // remove spaces around hyphens
    .replace(/\s+/g, " ")                    // collapse whitespace
    .replace(/[^\w\s-]/g, "")               // drop other punctuation
    .trim();
}

// A looser key for names: normalize + remove internal spaces entirely,
// so "One8 xWLDD" and "One8 x WLDD" match. Used for campaign + name keys.
export function keyOf(s) {
  return norm(s).replace(/\s+/g, "");
}

// Token-set similarity (Jaccard over word tokens) for issue text, 0..1.
// Cheap, no LLM. Good enough to catch light rewordings; the LLM is the fallback
// for genuine paraphrase where token overlap is low but meaning is the same.
export function issueSimilarity(a, b) {
  const ta = new Set(norm(a).split(" ").filter(w => w.length > 2));
  const tb = new Set(norm(b).split(" ").filter(w => w.length > 2));
  if (!ta.size && !tb.size) return 1;
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

// Decide if two campaign strings refer to the same campaign (tolerant).
export function sameCampaign(a, b) {
  return keyOf(a) === keyOf(b);
}

// Decide if two names refer to the same person (tolerant).
export function sameName(a, b) {
  return keyOf(a) === keyOf(b);
}

// Thresholds for issue-text sameness without the LLM.
// >= HIGH  -> confidently the same issue (deterministic path).
// <  LOW   -> confidently different issue.
// between  -> ambiguous; caller should use the LLM judge.
export const ISSUE_SAME_HIGH = 0.6;
export const ISSUE_SAME_LOW = 0.25;

// Classify issue sameness deterministically where possible.
// Returns "same" | "different" | "ambiguous".
export function issueSamenessFast(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return "same";
  const sim = issueSimilarity(a, b);
  if (sim >= ISSUE_SAME_HIGH) return "same";
  if (sim < ISSUE_SAME_LOW) return "different";
  return "ambiguous";
}
