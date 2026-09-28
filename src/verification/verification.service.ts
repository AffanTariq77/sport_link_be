import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { hasPgCode, UNIQUE_VIOLATION } from '../db/errors.js';
import { reports, users, verifications } from '../db/schema.js';
import { getSetting } from '../settings.js';
import { DocumentCrypto } from './document-crypto.js';
import { STORAGE, type FileStorage } from './storage.js';

export class VerificationError extends Error {
  constructor(
    public readonly code:
      | 'PROFILE_INCOMPLETE'
      | 'INVALID_DOCUMENT_NUMBER'
      | 'INVALID_IMAGE'
      | 'ALREADY_PENDING'
      | 'ALREADY_VERIFIED'
      | 'DUPLICATE_DOCUMENT',
    message: string,
  ) {
    super(message);
  }
}

export interface DocumentImage {
  buffer: Buffer;
  size: number;
}

// Check the file's first bytes rather than trusting the client's content type.
const isImage = (b: Buffer) =>
  (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
  b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || // PNG
  (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP');

@Injectable()
export class VerificationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: FileStorage,
    @Inject(DocumentCrypto) private readonly crypto: DocumentCrypto,
  ) {}

  /** What the app shows: current verification state and which document the user needs. */
  async status(userId: string) {
    const [user] = await this.db
      .select({ isMinor: users.isMinor, countryCode: users.countryCode })
      .from(users)
      .where(eq(users.id, userId));
    const [latest] = await this.db
      .select({ status: verifications.status, rejectionReason: verifications.rejectionReason })
      .from(verifications)
      .where(eq(verifications.userId, userId))
      .orderBy(desc(verifications.createdAt))
      .limit(1);
    return {
      status: latest?.status ?? ('none' as const),
      rejectionReason: latest?.status === 'rejected' ? latest.rejectionReason : null,
      docType: user?.isMinor ? ('b_form' as const) : ('cnic' as const),
      requiredAt: await getSetting(this.db, 'verification.required_at', user?.countryCode),
    };
  }

  /** Stores an encrypted CNIC (adults) or B-Form (minors) for admin review. */
  async submit(userId: string, input: { docNumber: string; front: DocumentImage; back: DocumentImage }) {
    const [user] = await this.db
      .select({ name: users.name, dob: users.dob, isMinor: users.isMinor, countryCode: users.countryCode })
      .from(users)
      .where(eq(users.id, userId));
    if (!user?.name || !user.dob) {
      throw new VerificationError('PROFILE_INCOMPLETE', 'Add your name and date of birth first.');
    }
    const docType = user.isMinor ? 'b_form' : 'cnic';
    const label = docType === 'cnic' ? 'CNIC' : 'B-Form';

    const docNumber = input.docNumber.replace(/[\s-]/g, '');
    if (!/^\d{13}$/.test(docNumber)) {
      throw new VerificationError('INVALID_DOCUMENT_NUMBER', `Enter your 13-digit ${label} number.`);
    }
    const maxBytes = await getSetting(this.db, 'verification.max_image_bytes', user.countryCode);
    for (const image of [input.front, input.back]) {
      if (image.size > maxBytes || !isImage(image.buffer)) {
        throw new VerificationError(
          'INVALID_IMAGE',
          `Photos must be JPEG, PNG or WebP and under ${Math.floor(maxBytes / 1_000_000)} MB.`,
        );
      }
    }

    const [active] = await this.db
      .select({ status: verifications.status })
      .from(verifications)
      .where(and(eq(verifications.userId, userId), ne(verifications.status, 'rejected')))
      .limit(1);
    if (active?.status === 'approved') throw new VerificationError('ALREADY_VERIFIED', 'Your ID is already verified.');
    if (active) throw new VerificationError('ALREADY_PENDING', 'Your ID is already being reviewed.');

    const id = randomUUID();
    const hash = this.crypto.hashNumber(docNumber);
    const keys = { frontKey: `verifications/${userId}/${id}-front`, backKey: `verifications/${userId}/${id}-back` };
    try {
      await this.db.insert(verifications).values({
        id,
        userId,
        docType,
        docNumberEncrypted: this.crypto.encryptNumber(docNumber),
        docNumberHash: hash,
        ...keys,
      });
    } catch (err) {
      if (!hasPgCode(err, UNIQUE_VIOLATION)) throw err;
      await this.flagDuplicate(userId, hash, user.isMinor);
      throw new VerificationError(
        'DUPLICATE_DOCUMENT',
        `This ${label} is already linked to another account. Our team will review it and contact you.`,
      );
    }

    try {
      await this.storage.put(keys.frontKey, this.crypto.encryptImage(input.front.buffer));
      await this.storage.put(keys.backKey, this.crypto.encryptImage(input.back.buffer));
    } catch (err) {
      await this.db.delete(verifications).where(eq(verifications.id, id));
      throw err;
    }
    return this.status(userId);
  }

  // Spec 5: block the second account and flag it for moderation.
  private async flagDuplicate(userId: string, hash: string, isMinor: boolean) {
    const [existing] = await this.db
      .select({ userId: verifications.userId })
      .from(verifications)
      .where(and(eq(verifications.docNumberHash, hash), ne(verifications.status, 'rejected')));
    if (existing?.userId === userId) {
      throw new VerificationError('ALREADY_PENDING', 'Your ID is already being reviewed.');
    }
    await this.db.insert(reports).values({
      reporterId: userId,
      targetType: 'user',
      targetId: userId,
      reason: 'duplicate_document',
      details: 'Automatic flag: submitted an identity document already used by another account.',
      evidence: { existingUserId: existing?.userId },
      involvesMinor: isMinor,
    });
  }
}
