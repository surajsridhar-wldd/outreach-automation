// Category-specific email CC rules.
//
// Add an entry here whenever a category of outreach needs extra recipients CC'd
// automatically. Keyed by category TAG (case-insensitive match), since tags are
// stable identifiers even if the category's display name is edited later.
//
// NOTE: the "Zero service cost" category's tag was created as NO_SERVOCE_COST
// (typo, kept as-is since renaming the tag would break existing tagged records).
const CATEGORY_CC_RULES = {
  NO_SERVOCE_COST: ["inventory@wldd.in"],
};

// Returns a comma-joined CC string for a record's category, or undefined if none.
export function ccForCategory(category) {
  if (!category) return undefined;
  const emails = CATEGORY_CC_RULES[String(category).toUpperCase()];
  return emails && emails.length ? emails.join(", ") : undefined;
}
