import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { ChatError, ChatService } from '../src/chat/chat.service.js';
import { containsPhoneNumber } from '../src/chat/phone-detect.js';
import { auditLog, bookings, messages, reports, users } from '../src/db/schema.js';
import { MatchesService } from '../src/matches/matches.service.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const chat = new ChatService(db);
const matches = new MatchesService(db, new DocumentCrypto(randomBytes(32).toString('base64')));
const engine = new BookingsService(db);
afterAll(() => pool.end());

const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof ChatError ? e.code : Promise.reject(e)),
  );
// Fake people only.
async function person(name: string) {
  const [u] = await db
    .insert(users)
    .values({ phone: `+9200${String(randomInt(0, 1e8)).padStart(8, '0')}`, countryCode: 'PK', name })
    .returning({ id: users.id });
  return u!.id;
}

let v: Awaited<ReturnType<typeof createVenue>>; // v.userId owns the venue
let host: string;
let player: string;
let matchChat: string;
let booking: { id: string };
beforeAll(async () => {
  v = await createVenue(db);
  host = await person('Host Test');
  player = await person('Player Test');
  const start = at('2030-01-07T18:00');
  booking = await engine.createHold({
    courtId: v.courtId,
    userId: host,
    startAt: start,
    endAt: new Date(start.getTime() + 3_600_000),
    now: NOW,
  });
  await db.update(bookings).set({ status: 'confirmed' }).where(eq(bookings.id, booking.id));
  const m = await matches.create(
    host,
    { sport: 'padel', bookingId: booking.id, slotsTotal: 4, hostBrings: 1, filters: {} },
    NOW,
  );
  await matches.join(player, m.id, {}, NOW);
  expect(await code(chat.openMatch(player, m.id))).toBe('NOT_FOUND'); // requested is not enough
  await matches.decide(host, m.id, player, true, NOW);
  ({ id: matchChat } = await chat.openMatch(host, m.id));
  expect((await chat.openMatch(player, m.id)).id).toBe(matchChat); // one conversation per match
});

describe('phone number detection', () => {
  it('catches Pakistani numbers written in many ways', () => {
    for (const t of [
      '03001234567',
      '0300 123 4567',
      '+92-300-1234567',
      '0092 300 1234567',
      'zero three zero zero one two three four five six seven',
      'sifar teen sifar sifar 1 2 3 4 5 6 7',
      '(042) 35761234',
    ]) {
      expect(containsPhoneNumber(t)).toBe(true);
    }
  });

  it('leaves ordinary match talk alone', () => {
    for (const t of [
      'See you at 7pm',
      'Court 3 at 18:00 on 12/10',
      'We won 3-2',
      'Paid Rs 4000, ID TEST123456',
      'Do you want to play at 9?',
    ]) {
      expect(containsPhoneNumber(t)).toBe(false);
    }
  });
});

describe('match chat', () => {
  it('host and approved players talk; anyone else is kept out', async () => {
    await chat.send(host, matchChat, { body: 'Bring a spare racket please' }, later(1));
    await chat.send(player, matchChat, { body: 'Will do' }, later(2));
    const thread = await chat.messages(player, matchChat, undefined, later(3));
    expect(thread.messages.map((m) => [m.senderName, m.body, m.mine])).toEqual([
      ['Host Test', 'Bring a spare racket please', false],
      ['Player Test', 'Will do', true],
    ]);
    const outsider = await person('Outsider Test');
    expect(await code(chat.messages(outsider, matchChat))).toBe('NOT_FOUND');
    expect(await code(chat.send(outsider, matchChat, { body: 'hi' }))).toBe('NOT_FOUND');
  });

  it('warns before sending a phone number, then sends it marked and logged once confirmed', async () => {
    expect(await code(chat.send(player, matchChat, { body: 'Text me on 0300 1234567' }, later(4)))).toBe(
      'PHONE_WARNING',
    );
    const sent = await chat.send(player, matchChat, { body: 'Text me on 0300 1234567', confirmPhone: true }, later(5));
    const [stored] = await db.select().from(messages).where(eq(messages.id, sent.id));
    expect(stored!.flaggedPhone).toBe(true);
    const logged = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'chat.phone_number_shared'), eq(auditLog.targetId, matchChat)));
    expect(logged).toHaveLength(1);
  });

  it('polls for new messages, and hides messages from someone you blocked', async () => {
    const since = later(5);
    await chat.send(host, matchChat, { body: 'Running 5 minutes late' }, later(6));
    expect((await chat.messages(player, matchChat, since)).messages.map((m) => m.body)).toEqual([
      'Running 5 minutes late',
    ]);
    await chat.block(player, host);
    expect((await chat.messages(player, matchChat)).messages.some((m) => m.senderName === 'Host Test')).toBe(false);
    await chat.unblock(player, host);
  });

  it('a report carries the recent messages for the moderators', async () => {
    const { id } = await chat.report(player, matchChat, { reason: 'abuse', details: 'Rude messages' });
    const [r] = await db.select().from(reports).where(eq(reports.id, id));
    const attached = (r!.evidence as { messages: { body: string }[] }).messages.map((m) => m.body);
    expect(attached).toContain('Bring a spare racket please');
    expect(r!.targetType).toBe('conversation');
  });
});

describe('booking chat', () => {
  it('connects the player with the venue, and the venue sees it with unread messages', async () => {
    const { id } = await chat.openBooking(host, booking.id);
    expect(await code(chat.openBooking(player, booking.id))).toBe('NOT_FOUND');
    await chat.send(host, id, { body: 'Is there parking?' }, later(10));
    const venueList = await chat.list(v.userId);
    expect(venueList.find((c) => c.id === id)).toMatchObject({
      type: 'booking',
      unread: 1,
      lastMessage: 'Is there parking?',
    });
    await chat.messages(v.userId, id, undefined, later(11));
    await chat.send(v.userId, id, { body: 'Yes, free parking at the back' }, later(12));
    expect((await chat.list(host)).find((c) => c.id === id)?.unread).toBe(1);
  });
});
