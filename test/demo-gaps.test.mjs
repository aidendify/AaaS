// Hours, listings, plain-English schedules, evening-before times, and canned mock chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpret, normalizeCompiled, nextFire, eveningBeforeAt, SCHEDULE_ERROR } from '../lib/workflows.js';
import { hoursForDay, upcomingSlots, wantedClock, formatMessageTime, todayAt, resolveQualify, contactFromText, demoSeedOn, rulesDecide } from '../lib/frontdesk.js';
import { parseListingCsv, matchListings, listingAnswer } from '../lib/listings.js';
import { mockChatReply } from '../lib/llm.js';
import { STARTERS } from '../lib/playbooks.js';

const parts = (ms, tz = 'Asia/Kolkata') => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit',
}).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));

test('plain-English schedules: Friday bookings, common clocks, and a clear refusal', () => {
  const friday = normalizeCompiled(interpret('Every Friday, remind people with bookings tomorrow'));
  assert.equal(friday.trigger.type, 'schedule');
  assert.equal(friday.trigger.weekday, 5);
  assert.equal(friday.trigger.every_days, 7);
  assert.equal(friday.trigger.hour, 9);
  assert.equal(friday.trigger.minute, 0);
  assert.equal(friday.trigger.audience, 'bookings_tomorrow');
  assert.equal(friday.steps[0].type, 'send_whatsapp');
  assert.equal(friday.steps[0].audience, 'bookings_tomorrow');
  assert.equal(friday.steps[0].autonomy, 'needs_approval');
  assert.match(friday.plain, /Every Friday at 09:00/);
  assert.match(friday.plain, /booking tomorrow/i);
  assert.match(friday.plain, /Nothing is sent until you approve/);

  const five = normalizeCompiled(interpret('Every Friday at 5pm, remind people with bookings tomorrow'));
  assert.equal(five.trigger.hour, 17);
  assert.equal(five.trigger.weekday, 5);

  const weekday = normalizeCompiled(interpret('Every weekday at 9am, remind me to check new leads'));
  assert.equal(weekday.trigger.weekdays, true);
  assert.equal(weekday.trigger.hour, 9);
  assert.equal(weekday.steps[0].type, 'remind');

  const daily = normalizeCompiled(interpret('Every day at 6, remind me to check the book'));
  assert.equal(daily.trigger.every_days, 1);
  assert.equal(daily.trigger.hour, 18);
  assert.equal(daily.trigger.weekday, undefined);

  const morning = normalizeCompiled(interpret('Every morning, remind me to check new leads'));
  assert.equal(morning.trigger.morning, true);
  assert.equal(morning.trigger.hour, 8);
  assert.equal(morning.trigger.every_days, 1);
  assert.match(morning.plain, /Every morning/);

  const refused = interpret('Every fortnight, remind people with bookings tomorrow');
  assert.equal(refused.error, SCHEDULE_ERROR);
  assert.match(interpret('Every hour, remind me to look').error, /every day, every weekday/);
  assert.match(interpret('Every day at 25pm, remind me to look').error, /Use a time like 9am/);
});

test('evening before is a clock on the reminder, and a new-lead sentence stays a lead trigger', () => {
  const lead = normalizeCompiled(interpret('When a new lead comes in, whatsapp them and remind me the evening before'));
  assert.equal(lead.trigger.type, 'lead.created');
  assert.equal(lead.trigger.evening_before, undefined);
  const evening = lead.steps.find((s) => s.when === 'evening_before');
  assert.ok(evening);
  assert.equal(evening.type, 'send_whatsapp');
  assert.equal(evening.hour, 18);
  assert.equal(evening.minute, 0);
  assert.equal(evening.autonomy, 'needs_approval');
  assert.equal(lead.steps.some((s) => s.type === 'remind'), false);
  assert.match(lead.plain, /evening before the appointment, at 18:00/);

  const only = normalizeCompiled(interpret('Remind people the evening before an appointment'));
  assert.equal(only.trigger.type, 'schedule');
  assert.equal(only.trigger.evening_before, true);
  assert.equal(only.steps[0].hour, 18);

  const start = Date.parse('2026-10-24T05:30:00Z');
  assert.equal(eveningBeforeAt(start, 'Asia/Kolkata', 18, 0), Date.parse('2026-10-23T12:30:00Z'));
  const due = parts(eveningBeforeAt(start, 'Asia/Kolkata', 18, 0));
  assert.equal(due.weekday, 'Fri');
  assert.equal(due.hour, '18');
  assert.equal(due.minute, '00');
});

test('nextFire uses the account timezone and stays after the previous tick', () => {
  const from = Date.parse('2026-10-20T12:00:00Z');
  const friday = nextFire({ type: 'schedule', weekday: 5, hour: 9, minute: 0, every_days: 7, timezone: 'Asia/Kolkata' }, from);
  const p = parts(friday);
  assert.equal(p.weekday, 'Fri');
  assert.equal(p.day, '23');
  assert.equal(p.hour, '09');
  assert.ok(friday > from);
  const again = nextFire({ type: 'schedule', weekday: 5, hour: 9, minute: 0, every_days: 7, timezone: 'Asia/Kolkata' }, friday);
  assert.equal(parts(again).day, '30');

  const morning = nextFire({ type: 'schedule', every_days: 1, morning: true, hour: 8, minute: 0, timezone: 'Asia/Kolkata' }, from);
  assert.ok(morning < from + 6 * 864e5);
  assert.equal(parts(morning).hour, '08');
});

test('per-day hours: Saturday-only slots, a different Monday, and 6pm is 18:00', () => {
  const now = Date.parse('2026-10-20T04:00:00Z');
  const split = {
    timezone: 'Asia/Kolkata', slot_minutes: 30, days: [1, 6], start: '11:00', end: '13:00',
    by_day: { 6: { start: '11:00', end: '13:00' }, 1: { start: '10:00', end: '12:00' } },
  };
  assert.equal(hoursForDay(split, 2), null);
  assert.equal(hoursForDay(split, 6).start, '11:00');
  assert.equal(hoursForDay(split, 1).end, '12:00');
  const monday = upcomingSlots(split, [], now, 3, null, 1);
  const saturday = upcomingSlots(split, [], now, 3, null, 6);
  assert.match(monday[0].label, /Mon/);
  assert.match(monday[0].label, /10:00/);
  assert.match(saturday[0].label, /Sat/);
  assert.match(saturday[0].label, /11:00/);
  assert.equal(upcomingSlots(split, [], now, 3, null, 2).length, 0);

  const wide = { timezone: 'Asia/Kolkata', slot_minutes: 30, days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '19:30', by_day: {} };
  assert.deepEqual(wantedClock('Slot at 6?'), { hour: 18, minute: 0 });
  const first = upcomingSlots(wide, [], now, 3);
  const six = upcomingSlots(wide, [], now, 3, wantedClock('Slot at 6?'));
  assert.match(first[0].label, /10:00/);
  assert.match(six[0].label, /18:00/);
  assert.equal(six.every((s) => s.label.includes('18:00')), true);
});

test('listings match a type, import a CSV, and keep formula cells as text', () => {
  const rows = parseListingCsv('title,type,location,price,status,notes\nLakeview Residency,3BHK,Pune,₹1.15 crore,available,1450 sq ft\n=cmd,2BHK,Pune,1,sold,no\n');
  assert.equal(rows[0].title, 'Lakeview Residency');
  assert.equal(rows[0].status, 'available');
  assert.equal(rows[1].title, "'=cmd");
  assert.equal(rows[1].status, 'sold');
  const hits = matchListings(rows, '3BHK still available?');
  assert.equal(hits.length, 1);
  assert.match(listingAnswer(hits), /^Yes\. Lakeview Residency/);
  assert.match(listingAnswer(hits), /book a slot/);
  assert.match(listingAnswer(matchListings(rows, 'is the 2BHK free')), /^No\./);
  assert.throws(() => parseListingCsv('name,city\nA,B\n'), /title and type/);
});

test('mock chat is a canned sentence, stable, and does not call a model', () => {
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => { called++; throw new Error('network'); };
  try {
    const laser = mockChatReply('Is Saturday free for laser?');
    assert.equal(laser, mockChatReply('Is Saturday free for laser?'));
    assert.match(laser, /Saturday/);
    assert.doesNotMatch(laser, /\[mock/);
    assert.match(mockChatReply('What are your fees?'), /draft/i);
    assert.match(mockChatReply('3BHK still available?'), /listing/i);
    assert.match(mockChatReply('Slot at 6?'), /approval/i);
    assert.match(mockChatReply('Add a client workspace and set branding'), /does not send email/);
    assert.match(mockChatReply('Hello there'), /drafted/i);
    assert.equal(called, 0);
  } finally { globalThis.fetch = real; }
});

test('message clocks, qualify sets, and a visitor name', () => {
  const evening = Date.parse('2026-10-17T22:47:00+05:30');
  assert.equal(formatMessageTime(evening, 'Asia/Kolkata'), '10:47pm');
  assert.equal(formatMessageTime(todayAt(22, 47, 'Asia/Kolkata'), 'Asia/Kolkata'), '10:47pm');
  assert.match(resolveQualify({ vertical: 'coach' })[0].ask, /pipeline/);
  assert.match(resolveQualify({ vertical: 'consultant' })[0].ask, /pipeline/);
  assert.match(resolveQualify({ vertical: 'clinic_skin' })[0].ask, /consultation/);
  assert.match(resolveQualify({ vertical: 'realestate' })[0].ask, /buy, rent, or sell/);
  assert.match(resolveQualify({ vertical: 'gym' })[0].ask, /cut, a class, or a trial/);
  assert.match(resolveQualify({ vertical: 'agency' })[0].ask, /this client/);
  assert.match(resolveQualify({ qualify_set: 'clinic', vertical: 'coach' })[0].ask, /consultation/);
  assert.equal(resolveQualify({ qualify_questions: [{ ask: 'Who referred you?' }] })[0].ask, 'Who referred you?');
  assert.match(resolveQualify({})[0].ask, /ads, email, the website, or a retainer/);
  const who = contactFromText('My name is Priya Shah. Phone 9845011122. Email priya.shah@example.com');
  assert.equal(who.name, 'Priya Shah');
  assert.equal(who.phone, '+919845011122');
  assert.equal(who.email, 'priya.shah@example.com');
  assert.equal(contactFromText('My name is Priya Shah').phone, '');
  assert.equal(contactFromText('Is Saturday free for laser?').name, '');
  const priced = rulesDecide({ text: 'Budget 20000', profile: {}, faqs: [], lead: {}, slots: [], offered: [], listings: [], questions: [] });
  assert.equal(priced.qualify.budget, '20000');
  const phone = rulesDecide({ text: 'My name is Priya Shah. Phone 9845011122. Email priya.shah@example.com', profile: {}, faqs: [], lead: {}, slots: [], offered: [], listings: [], questions: [] });
  assert.equal(phone.qualify.budget || '', '');
  const prevSeed = process.env.DEMO_SEED;
  const prevMode = process.env.DEMO_MODE;
  delete process.env.DEMO_SEED;
  delete process.env.DEMO_MODE;
  assert.equal(demoSeedOn(), false);
  process.env.DEMO_SEED = '1';
  assert.equal(demoSeedOn(), true);
  if (prevSeed == null) delete process.env.DEMO_SEED; else process.env.DEMO_SEED = prevSeed;
  if (prevMode == null) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prevMode;
});

test('starter playbooks still compile, including the weekly reminder', () => {
  assert.equal(STARTERS.length, 3);
  const email = STARTERS.find((p) => p.id === 'pb_email');
  assert.ok(email.workflows.some((w) => w.trigger && w.trigger.type === 'schedule' && w.status === 'draft'));
  const agency = STARTERS.find((p) => p.id === 'pb_agency');
  assert.equal(agency.workflows.every((w) => w.status === 'draft'), true);
});
