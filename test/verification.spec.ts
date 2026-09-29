import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { reports, users, verifications } from '../src/db/schema.js';
import { ageOn, ProfileError, ProfileService } from '../src/users/profile.service.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import type { FileStorage } from '../src/verification/storage.js';
import { VerificationError, VerificationService } from '../src/verification/verification.service.js';
import { ensurePakistan, testDb } from './fixtures.js';

const { db, pool } = testDb();
const stored = new Map<string, Buffer>();
const storage: FileStorage = {
  put: async (key, data) => void stored.set(key, data),
  get: async (key) => stored.get(key)!,
  delete: async (key) => void stored.delete(key),
};
const crypto = new DocumentCrypto(randomBytes(32).toString('base64'));
const profiles = new ProfileService(db);
const service = new VerificationService(db, storage, crypto);
afterAll(() => pool.end());
beforeAll(() => ensurePakistan(db));

const NOW = new Date('2030-06-15T12:00:00Z');
const jpeg = (fill = 1) => {
  const buffer = Buffer.alloc(2000, fill);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return { buffer, size: buffer.length };
};
// Fake numbers only: 13 digits, never a real CNIC. Each test gets its own.
let n = 0;
const fakeCnic = () => `99999-${String(1_000_000 + ++n).slice(-7)}-1`;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof VerificationError || e instanceof ProfileError ? e.code : Promise.reject(e)),
  );

async function newUser(dob: string | null = '1995-03-10') {
  const [u] = await db
    .insert(users)
    .values({ phone: `+923020${String(1_000_000 + ++n).slice(-6)}`, countryCode: 'PK' })
    .returning({ id: users.id });
  if (dob) await profiles.update(u!.id, { name: 'Test Player', dob, gender: 'prefer_not_to_say', city: 'Lahore' }, NOW);
  return u!.id;
}

describe('profile', () => {
  it('works out age on the birthday boundary', () => {
    expect(ageOn('2012-06-15', NOW)).toBe(18);
    expect(ageOn('2012-06-16', NOW)).toBe(17);
  });

  it('marks under-18s as minors', async () => {
    const adult = await profiles.update(await newUser(null), p('2012-06-15'), NOW);
    const minor = await profiles.update(await newUser(null), p('2012-06-16'), NOW);
    expect([adult.isMinor, minor.isMinor]).toEqual([false, true]);
  });

  it('rejects impossible and future dates of birth', async () => {
    const id = await newUser(null);
    for (const dob of ['2001-02-30', '2031-01-01', '1890-01-01']) {
      expect(await code(profiles.update(id, p(dob), NOW))).toBe('INVALID_DOB');
    }
  });

  it('locks date of birth once a document is submitted', async () => {
    const id = await newUser();
    await service.submit(id, { docNumber: fakeCnic(), front: jpeg(), back: jpeg() });
    expect(await code(profiles.update(id, p('1990-01-01'), NOW))).toBe('DOB_LOCKED');
    expect(await code(profiles.update(id, { ...p('1995-03-10'), name: 'New Name' }, NOW))).toBe('OK');
  });

  function p(dob: string) {
    return { name: 'Test Player', dob, gender: 'female' as const, city: 'Karachi' };
  }
});

describe('document submission', () => {
  it('stores the number and photos encrypted, never in plain form', async () => {
    const id = await newUser();
    const docNumber = fakeCnic();
    const front = jpeg(7);
    const result = await service.submit(id, { docNumber, front, back: jpeg(8) });
    expect(result).toMatchObject({ status: 'pending', docType: 'cnic', requiredAt: 'signup' });

    const [row] = await db.select().from(verifications).where(eq(verifications.userId, id));
    const digits = docNumber.replace(/-/g, '');
    expect(row!.docNumberEncrypted).not.toContain(digits);
    expect(crypto.decryptNumber(row!.docNumberEncrypted)).toBe(digits);
    const saved = stored.get(row!.frontKey)!;
    expect(saved.includes(front.buffer.subarray(4, 64))).toBe(false);
    expect(crypto.decryptImage(saved).equals(front.buffer)).toBe(true);
  });

  it('asks minors for a B-Form', async () => {
    const id = await newUser('2015-01-01');
    expect((await service.status(id)).docType).toBe('b_form');
    const result = await service.submit(id, { docNumber: fakeCnic(), front: jpeg(), back: jpeg() });
    expect(result.docType).toBe('b_form');
  });

  it('needs a profile, a 13-digit number and real images', async () => {
    expect(
      await code(service.submit(await newUser(null), { docNumber: fakeCnic(), front: jpeg(), back: jpeg() })),
    ).toBe('PROFILE_INCOMPLETE');
    const id = await newUser();
    expect(await code(service.submit(id, { docNumber: '12345', front: jpeg(), back: jpeg() }))).toBe(
      'INVALID_DOCUMENT_NUMBER',
    );
    const notImage = { buffer: Buffer.from('%PDF-1.7 not an image'), size: 21 };
    expect(await code(service.submit(id, { docNumber: fakeCnic(), front: notImage, back: jpeg() }))).toBe(
      'INVALID_IMAGE',
    );
    const huge = { ...jpeg(), size: 6_000_000 };
    expect(await code(service.submit(id, { docNumber: fakeCnic(), front: jpeg(), back: huge }))).toBe('INVALID_IMAGE');
  });

  it('allows one active submission, and a new one after rejection', async () => {
    const id = await newUser();
    await service.submit(id, { docNumber: fakeCnic(), front: jpeg(), back: jpeg() });
    expect(await code(service.submit(id, { docNumber: fakeCnic(), front: jpeg(), back: jpeg() }))).toBe(
      'ALREADY_PENDING',
    );
    await db
      .update(verifications)
      .set({ status: 'rejected', rejectionReason: 'Photo is blurry.' })
      .where(eq(verifications.userId, id));
    expect((await service.status(id)).rejectionReason).toBe('Photo is blurry.');
    expect(await code(service.submit(id, { docNumber: fakeCnic(), front: jpeg(), back: jpeg() }))).toBe('OK');
  });

  it('blocks a CNIC already used by another account and flags it for moderation', async () => {
    const docNumber = fakeCnic();
    const first = await newUser();
    await service.submit(first, { docNumber, front: jpeg(), back: jpeg() });
    const second = await newUser();
    expect(
      await code(service.submit(second, { docNumber: docNumber.replace(/-/g, ''), front: jpeg(), back: jpeg() })),
    ).toBe('DUPLICATE_DOCUMENT');
    const flags = await db
      .select()
      .from(reports)
      .where(and(eq(reports.targetId, second), eq(reports.reason, 'duplicate_document')));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.evidence).toEqual({ existingUserId: first });
  });

  it('lets only one of two accounts claim the same CNIC at the same moment', async () => {
    const docNumber = fakeCnic();
    const [a, b] = [await newUser(), await newUser()];
    const results = await Promise.all(
      [a, b].map((id) => code(service.submit(id, { docNumber, front: jpeg(), back: jpeg() }))),
    );
    expect(results.sort()).toEqual(['DUPLICATE_DOCUMENT', 'OK']);
  });
});
