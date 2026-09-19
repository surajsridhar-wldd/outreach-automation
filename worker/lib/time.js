// Calendar rules for the nudge schedule.
//
// Everything works on IST calendar dates ('YYYY-MM-DD') so results never depend on the
// timezone of the machine that runs the worker. India has no daylight saving, so IST is a
// fixed UTC+5:30 offset.

const IST_OFFSET_MIN = 330;
const DAY_MS = 86_400_000;

/** IST calendar date of an instant. */
export function istDate(instant = new Date()) {
  return new Date(new Date(instant).getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** IST wall-clock hour (0-23) and minute of an instant. */
export function istClock(instant = new Date()) {
  const t = new Date(new Date(instant).getTime() + IST_OFFSET_MIN * 60_000);
  return { hour: t.getUTCHours(), minute: t.getUTCMinutes() };
}

/** UTC calendar date of an instant (Mongo dates are compared on their UTC date). */
export function utcDate(instant = new Date()) {
  return new Date(instant).toISOString().slice(0, 10);
}

export function addDays(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from a to b (b - a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday. */
export function dow(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

export function isWorkingDay(dateStr, holidays = new Set()) {
  const d = dow(dateStr);
  return d !== 0 && d !== 6 && !holidays.has(dateStr);
}

export function nextWorkingDay(dateStr, holidays = new Set()) {
  let d = addDays(dateStr, 1);
  while (!isWorkingDay(d, holidays)) d = addDays(d, 1);
  return d;
}

/** Working days in the half-open range (from, to]: strictly after `from`, up to and including `to`. */
export function workingDaysAfter(from, to, holidays = new Set()) {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (isWorkingDay(d, holidays)) n++;
  return n;
}

/** All working days of the month that contains dateStr, ascending. */
export function workingDaysOfMonth(dateStr, holidays = new Set()) {
  const ym = dateStr.slice(0, 7);
  const out = [];
  for (let d = `${ym}-01`; d.slice(0, 7) === ym; d = addDays(d, 1)) if (isWorkingDay(d, holidays)) out.push(d);
  return out;
}

/** True from the Nth-last working day of the month up to the month's last working day. */
export function inMonthEndWindow(dateStr, holidays = new Set(), fromLastN = 6) {
  if (!isWorkingDay(dateStr, holidays)) return false;
  const days = workingDaysOfMonth(dateStr, holidays);
  const start = days[Math.max(0, days.length - fromLastN)];
  return dateStr >= start;
}

/** True on the last `lastN` working days of the month. */
export function isFinalNoticeDay(dateStr, holidays = new Set(), lastN = 2) {
  if (!isWorkingDay(dateStr, holidays)) return false;
  const days = workingDaysOfMonth(dateStr, holidays);
  return days.slice(-lastN).includes(dateStr);
}

/**
 * Mon/Wed/Fri are the nudge days. If a Mon or Wed is a holiday, the next working day
 * (Tue or Thu) takes its place, so nothing silently skips a slot.
 */
export function isNudgeDay(dateStr, holidays = new Set()) {
  if (!isWorkingDay(dateStr, holidays)) return false;
  const d = dow(dateStr);
  if (d === 1 || d === 3 || d === 5) return true;
  const prev = addDays(dateStr, -1);
  return (dow(prev) === 1 || dow(prev) === 3) && !isWorkingDay(prev, holidays);
}

/**
 * The weekly slot (Wednesday, or the next working day if Wednesday is a holiday) that
 * applies on dateStr. A weekly item is due when it was last nudged before this slot.
 * Because it stays due until sent, a slot that missed capacity is picked up on the next
 * run day instead of waiting a whole week.
 */
export function weeklySlot(dateStr, holidays = new Set()) {
  const slotFor = (wed) => (isWorkingDay(wed, holidays) ? wed : nextWorkingDay(wed, holidays));
  let wed = dateStr;
  while (dow(wed) !== 3) wed = addDays(wed, -1);
  let slot = slotFor(wed);
  if (slot > dateStr) slot = slotFor(addDays(wed, -7));
  return slot;
}

/** Sends are only allowed on working days between startHour (inclusive) and endHour (exclusive) IST. */
export function inSendWindow(instant, holidays = new Set(), startHour = 11, endHour = 19) {
  if (!isWorkingDay(istDate(instant), holidays)) return false;
  const { hour } = istClock(instant);
  return hour >= startHour && hour < endHour;
}
