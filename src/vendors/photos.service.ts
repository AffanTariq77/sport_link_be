import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { branches, vendors } from '../db/schema.js';
import { getSetting } from '../settings.js';
import { imageType, STORAGE, type FileStorage } from '../verification/storage.js';
import { VendorError } from './vendors.service.js';

/** Public path of a venue photo; the id is random, so paths cannot be guessed. */
export const photoUrl = (key: string) => `/${key.replace(/^venues\/([^/]+)\//, 'venues/$1/photos/')}`;

/** Venue photo gallery (spec 13.1). Owner only, like the rest of onboarding. Served publicly through the API. */
@Injectable()
export class PhotosService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: FileStorage,
  ) {}

  async add(userId: string, branchId: string, image: { buffer: Buffer; size: number }) {
    const b = await this.ownBranch(userId, branchId);
    const max = await getSetting(this.db, 'venue.max_photos', b.countryCode);
    if (b.photoKeys.length >= max) throw new VendorError('TOO_MANY_PHOTOS', `A venue can have up to ${max} photos.`);
    const maxBytes = await getSetting(this.db, 'venue.max_photo_bytes', b.countryCode);
    if (image.size > maxBytes || !imageType(image.buffer)) {
      throw new VendorError(
        'INVALID_IMAGE',
        `Upload a JPEG, PNG or WebP photo under ${Math.floor(maxBytes / 1e6)} MB.`,
      );
    }
    const key = `venues/${branchId}/${randomUUID()}`;
    await this.storage.put(key, image.buffer);
    await this.db
      .update(branches)
      .set({ photoKeys: sql`array_append(${branches.photoKeys}, ${key})`, updatedAt: new Date() })
      .where(eq(branches.id, branchId));
    return { url: photoUrl(key) };
  }

  async remove(userId: string, branchId: string, photoId: string) {
    const b = await this.ownBranch(userId, branchId);
    const key = `venues/${branchId}/${photoId}`;
    if (!b.photoKeys.includes(key)) throw new VendorError('NOT_FOUND', 'Photo not found.');
    await this.db
      .update(branches)
      .set({ photoKeys: sql`array_remove(${branches.photoKeys}, ${key})`, updatedAt: new Date() })
      .where(eq(branches.id, branchId));
    await this.storage.delete(key);
    return { ok: true };
  }

  /** Public: only keys still listed on the branch are served. */
  async get(branchId: string, photoId: string) {
    const key = `venues/${branchId}/${photoId}`;
    const [b] = await this.db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.id, branchId), sql`${key} = any(${branches.photoKeys})`));
    if (!b) throw new VendorError('NOT_FOUND', 'Photo not found.');
    const image = await this.storage.get(key);
    return { image, contentType: imageType(image) ?? 'application/octet-stream' };
  }

  private async ownBranch(userId: string, branchId: string) {
    const [b] = await this.db
      .select({ photoKeys: branches.photoKeys, countryCode: vendors.countryCode })
      .from(branches)
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .where(and(eq(branches.id, branchId), eq(vendors.ownerUserId, userId)));
    if (!b) throw new VendorError('NOT_FOUND', 'Venue not found.');
    return b;
  }
}
