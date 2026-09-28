import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { userColumns } from '../auth/auth.service.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { gender, users, verifications } from '../db/schema.js';
import { getSetting } from '../settings.js';

export class ProfileError extends Error {
  constructor(
    public readonly code: 'INVALID_DOB' | 'DOB_LOCKED' | 'TOO_YOUNG',
    message: string,
  ) {
    super(message);
  }
}

export interface ProfileInput {
  name: string;
  dob: string; // YYYY-MM-DD
  gender: (typeof gender.enumValues)[number];
  city: string;
}

/** Whole years between a YYYY-MM-DD birth date and `now` (UTC calendar dates). */
export function ageOn(dob: string, now: Date) {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const birthdayPassed = now.getUTCMonth() + 1 > m || (now.getUTCMonth() + 1 === m && now.getUTCDate() >= d);
  return now.getUTCFullYear() - y - (birthdayPassed ? 0 : 1);
}

@Injectable()
export class ProfileService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Saves the sign-up profile. Date of birth decides minor status and is locked once a document is submitted. */
  async update(userId: string, input: ProfileInput, now = new Date()) {
    const date = new Date(`${input.dob}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.dob || date > now) {
      throw new ProfileError('INVALID_DOB', 'Enter a real date of birth.');
    }
    const age = ageOn(input.dob, now);
    if (age > 120) throw new ProfileError('INVALID_DOB', 'Enter a real date of birth.');
    // Foundation 10.2 safeguard (setting): under-13s only through a parent's account.
    if (age < (await getSetting(this.db, 'minors.minimum_age'))) {
      throw new ProfileError('TOO_YOUNG', 'Players under 13 need a parent to use their own account for them.');
    }

    const [current] = await this.db.select({ dob: users.dob }).from(users).where(eq(users.id, userId));
    if (current?.dob && current.dob !== input.dob) {
      const [submitted] = await this.db
        .select({ id: verifications.id })
        .from(verifications)
        .where(and(eq(verifications.userId, userId), ne(verifications.status, 'rejected')))
        .limit(1);
      if (submitted) {
        throw new ProfileError('DOB_LOCKED', 'Your date of birth cannot be changed after your ID is submitted.');
      }
    }

    const [user] = await this.db
      .update(users)
      .set({
        name: input.name.trim(),
        dob: input.dob,
        gender: input.gender,
        city: input.city.trim(),
        isMinor: age < 18,
        updatedAt: now,
      })
      .where(eq(users.id, userId))
      .returning(userColumns);
    return user!;
  }
}
