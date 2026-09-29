import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { ChatService } from '../src/chat/chat.service.js';
import { blocks, bookings, branches, paymentAccounts, users, vendorStaff } from '../src/db/schema.js';
import { MatchesService } from '../src/matches/matches.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import type { PushMessage } from '../src/notifications/push.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const pushed: PushMessage[] = [];
const notes = new NotificationsService(db, { send: async (m) => void pushed.push(...m) });
const crypto = new DocumentCrypto(randomBytes(32).toString('base64'));
const payments = new PaymentsService(db, crypto, notes);
const matches = new MatchesService(db, crypto, notes);
const chat = new ChatService(db, notes);
const engine = new BookingsService(db);
afterAll(() => pool.end());

// Fake people only.
async function person(name = 'Notify Test') {
  const [u] = await db
    .insert(users)
    .values({ phone: `+9200${String(randomInt(0, 1e8)).padStart(8, '0')}`, countryCode: 'PK', name })
    .returning({ id: users.id });
  return u!.id;
}
const titles = async (userId: string) => (await notes.list(userId)).items.map((n) => n.title);

let v: Awaited<ReturnType<typeof createVenue>>;
let vendorId: string;
let hour = 6;
const hold = (userId: string) => {
  const start = at(`2030-01-07T${String(hour++).padStart(2, '0')}:00`);
  return engine.createHold({
    courtId: v.courtId,
    userId,
    startAt: start,
    endAt: new Date(start.getTime() + 3_600_000),
    now: NOW,
  });
};

beforeAll(async () => {
  v = await createVenue(db);
  [{ vendorId }] = (await db
    .select({ vendorId: branches.vendorId })
    .from(branches)
    .where(eq(branches.id, v.branchId))) as [{ vendorId: string }];
  await db.insert(paymentAccounts).values({
    vendorId,
    method: 'jazzcash',
    accountTitle: 'Test Venue',
    accountNumberEncrypted: crypto.encryptAccount('0300 0000000'),
    status: 'approved',
  });
});

describe('notifications', () => {
  it('payment submitted tells the venue (branch-scoped staff only); confirming tells the player', async () => {
    const [here, elsewhere] = [await person(), await person()];
    await db.insert(vendorStaff).values([
      { vendorId, userId: here, branchIds: [v.branchId], permissions: ['confirm_payments'] },
      { vendorId, userId: elsewhere, branchIds: [randomUUID()], permissions: ['confirm_payments'] },
    ]);
    const player = await person();
    const b = await hold(player);
    await notes.registerDevice(player, {
      fingerprint: 'test-device',
      platform: 'android',
      pushToken: 'ExponentPushToken[test]',
    });

    await payments.submit(b.id, player, { method: 'jazzcash', txnReference: `TEST${randomInt(0, 1e9)}` }, NOW);
    expect(await titles(v.userId)).toContain('Payment to check');
    expect(await titles(here)).toContain('Payment to check');
    expect(await titles(elsewhere)).toEqual([]);

    const item = (await payments.queue(v.userId, NOW)).find((q) => q.booking.id === b.id)!;
    await payments.confirm(item.id, v.userId, NOW);
    expect(await titles(player)).toContain('Booking confirmed');
    expect(pushed.some((p) => p.to === 'ExponentPushToken[test]')).toBe(true);

    const list = await notes.list(player);
    expect(list.unread).toBeGreaterThan(0);
    await notes.markRead(player);
    expect((await notes.list(player)).unread).toBe(0);
  });

  it('chat messages notify other members once per unread chat, never the sender or a blocker', async () => {
    const [host, player, blocker] = [await person('Host'), await person('Player'), await person('Blocker')];
    const b = await hold(host);
    await db.update(bookings).set({ status: 'confirmed' }).where(eq(bookings.id, b.id));
    const m = await matches.create(
      host,
      { sport: 'padel', bookingId: b.id, slotsTotal: 4, hostBrings: 1, filters: {} },
      NOW,
    );
    for (const p of [player, blocker]) {
      await matches.join(p, m.id, {}, NOW);
      await matches.decide(host, m.id, p, true, NOW);
    }
    expect(await titles(host)).toContain('Join request');
    await db.insert(blocks).values({ blockerId: blocker, blockedId: host });

    const { id } = await chat.openMatch(host, m.id);
    await chat.send(host, id, { body: 'See you at six' }, NOW);
    await chat.send(host, id, { body: 'Bring water' }, NOW);
    const chats = (await notes.list(player)).items.filter((n) => n.kind === 'chat');
    expect(chats).toHaveLength(1);
    expect(chats[0]!.link).toBe(`/chats/${id}`);
    expect((await notes.list(host)).items.filter((n) => n.kind === 'chat')).toEqual([]);
    expect((await notes.list(blocker)).items.filter((n) => n.kind === 'chat')).toEqual([]);
  });
});
