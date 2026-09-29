import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { settings } from '../src/db/schema.js';
import { PhotosService } from '../src/vendors/photos.service.js';
import { VendorError } from '../src/vendors/vendors.service.js';
import type { FileStorage } from '../src/verification/storage.js';
import { VenuesService } from '../src/venues/venues.service.js';
import { createVenue, testDb } from './fixtures.js';

const { db, pool } = testDb();
const files = new Map<string, Buffer>();
const storage: FileStorage = {
  put: async (k, d) => void files.set(k, d),
  get: async (k) => files.get(k)!,
  delete: async (k) => void files.delete(k),
};
const photos = new PhotosService(db, storage);
afterAll(() => pool.end());

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof VendorError ? e.code : Promise.reject(e)),
  );
const jpeg = Buffer.alloc(300, 1);
jpeg.set([0xff, 0xd8, 0xff]);
const file = (buffer: Buffer) => ({ buffer, size: buffer.length });

let v: Awaited<ReturnType<typeof createVenue>>;
beforeAll(async () => {
  v = await createVenue(db);
});

describe('venue photos', () => {
  it('the owner adds a photo; players see it on the venue and can load it', async () => {
    expect(await code(photos.add(v.userId, v.branchId, file(Buffer.from('not an image'))))).toBe('INVALID_IMAGE');
    expect(await code(photos.add(randomUUID(), v.branchId, file(jpeg)))).toBe('NOT_FOUND');

    const { url } = await photos.add(v.userId, v.branchId, file(jpeg));
    expect(url).toMatch(new RegExp(`^/venues/${v.branchId}/photos/[0-9a-f-]{36}$`));
    const venue = await new VenuesService(db).get(v.branchId);
    expect(venue.photos).toEqual([url]);
    expect((await new VenuesService(db).list({})).find((x) => x.id === v.branchId)?.photos).toEqual([url]);

    const photoId = url.split('/').pop()!;
    const served = await photos.get(v.branchId, photoId);
    expect(served.contentType).toBe('image/jpeg');
    expect(served.image.equals(jpeg)).toBe(true);
    expect(await code(photos.get(v.branchId, randomUUID()))).toBe('NOT_FOUND');
  });

  it('removing a photo deletes the file and stops serving it; the limit is a setting', async () => {
    const other = await createVenue(db);
    const { url } = await photos.add(other.userId, other.branchId, file(jpeg));
    const photoId = url.split('/').pop()!;
    await photos.remove(other.userId, other.branchId, photoId);
    expect(await code(photos.get(other.branchId, photoId))).toBe('NOT_FOUND');
    expect([...files.keys()].some((k) => k.endsWith(photoId))).toBe(false);

    await db.insert(settings).values({ key: 'venue.max_photos', countryCode: 'PK', value: 1 });
    try {
      await photos.add(other.userId, other.branchId, file(jpeg));
      expect(await code(photos.add(other.userId, other.branchId, file(jpeg)))).toBe('TOO_MANY_PHOTOS');
    } finally {
      await db.delete(settings).where(and(eq(settings.key, 'venue.max_photos'), eq(settings.countryCode, 'PK')));
    }
  });
});
