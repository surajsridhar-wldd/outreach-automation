import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  istDate, workingDaysAfter, isNudgeDay, inMonthEndWindow, isFinalNoticeDay, weeklySlot,
  inSendWindow, workingDaysOfMonth, nextWorkingDay, addDays, daysBetween,
} from '../lib/time.js';

const none = new Set();

test('istDate rolls over at 18:30 UTC', () => {
  assert.equal(istDate(new Date('2026-09-19T18:29:00Z')), '2026-09-19');
  assert.equal(istDate(new Date('2026-09-19T18:30:00Z')), '2026-09-20');
});

test('working days after: Mon->Wed is 2, Fri->Mon is 1 (so a Friday nudge is not due again on Monday)', () => {
  assert.equal(workingDaysAfter('2026-10-05', '2026-10-07', none), 2);
  assert.equal(workingDaysAfter('2026-10-09', '2026-10-12', none), 1);
  assert.equal(workingDaysAfter('2026-10-09', '2026-10-14', none), 3);
});

test('holidays are not counted as working days', () => {
  const h = new Set(['2026-10-06']);
  assert.equal(workingDaysAfter('2026-10-05', '2026-10-07', h), 1);
});

test('nudge days are Mon/Wed/Fri, and shift to the next working day when Mon/Wed is a holiday', () => {
  assert.equal(isNudgeDay('2026-10-05', none), true);   // Mon
  assert.equal(isNudgeDay('2026-10-06', none), false);  // Tue
  assert.equal(isNudgeDay('2026-10-07', none), true);   // Wed
  assert.equal(isNudgeDay('2026-10-08', none), false);  // Thu
  assert.equal(isNudgeDay('2026-10-09', none), true);   // Fri
  assert.equal(isNudgeDay('2026-10-10', none), false);  // Sat
  const wedHoliday = new Set(['2026-10-07']);
  assert.equal(isNudgeDay('2026-10-07', wedHoliday), false);
  assert.equal(isNudgeDay('2026-10-08', wedHoliday), true);
  const monHoliday = new Set(['2026-10-05']);
  assert.equal(isNudgeDay('2026-10-06', monHoliday), true);
});

test('month-end window starts on the 6th-last working day (Oct 2026: 23rd) and follows holidays', () => {
  assert.equal(inMonthEndWindow('2026-10-22', none), false);
  assert.equal(inMonthEndWindow('2026-10-23', none), true);
  assert.equal(inMonthEndWindow('2026-10-30', none), true);
  assert.equal(inMonthEndWindow('2026-10-31', none), false); // Saturday
  // a holiday inside the window pulls the start one working day earlier
  assert.equal(inMonthEndWindow('2026-10-22', new Set(['2026-10-27'])), true);
});

test('final notice is the last 2 working days of the month', () => {
  assert.equal(isFinalNoticeDay('2026-10-28', none), false);
  assert.equal(isFinalNoticeDay('2026-10-29', none), true);
  assert.equal(isFinalNoticeDay('2026-10-30', none), true);
});

test('weekly slot is Wednesday, or the next working day when Wednesday is a holiday', () => {
  assert.equal(weeklySlot('2026-10-09', none), '2026-10-07'); // Fri -> that week's Wed
  assert.equal(weeklySlot('2026-10-06', none), '2026-09-30'); // Tue -> previous Wed
  assert.equal(weeklySlot('2026-10-08', new Set(['2026-10-07'])), '2026-10-08');
  assert.equal(weeklySlot('2026-10-09', new Set(['2026-10-07'])), '2026-10-08');
});

test('send window is 11:00-19:00 IST on working days only', () => {
  assert.equal(inSendWindow(new Date('2026-10-05T05:29:00Z'), none), false); // 10:59 IST
  assert.equal(inSendWindow(new Date('2026-10-05T05:30:00Z'), none), true);  // 11:00 IST
  assert.equal(inSendWindow(new Date('2026-10-05T13:29:00Z'), none), true);  // 18:59 IST
  assert.equal(inSendWindow(new Date('2026-10-05T13:30:00Z'), none), false); // 19:00 IST
  assert.equal(inSendWindow(new Date('2026-10-10T07:00:00Z'), none), false); // Saturday
  assert.equal(inSendWindow(new Date('2026-10-05T07:00:00Z'), new Set(['2026-10-05'])), false); // holiday
});

test('small helpers', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(daysBetween('2026-09-12', '2026-09-19'), 7);
  assert.equal(nextWorkingDay('2026-10-09', none), '2026-10-12');
  assert.equal(workingDaysOfMonth('2026-10-15', none).length, 22);
});
