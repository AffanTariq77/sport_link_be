import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, lte, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { matchPlayers, matches, ratings, reviews, sports, users, verifications } from '../db/schema.js';
import { getSetting } from '../settings.js';
import { ResultError } from './results.service.js';

export function tierFor(rating: number, tiers: { name: string; min: number }[]) {
  return [...tiers].sort((a, b) => b.min - a.min).find((t) => rating >= t.min)?.name ?? null;
}

/** Public player profiles and leaderboards (spec 11.5, 11.6). Never phone numbers or exact locations. */
@Injectable()
export class PlayersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async profile(playerId: string) {
    const [u] = await this.db
      .select({ id: users.id, name: users.name, city: users.city, status: users.status })
      .from(users)
      .where(eq(users.id, playerId));
    if (!u || u.status === 'banned' || u.status === 'deleted' || !u.name)
      throw new ResultError('NOT_FOUND', 'Player not found.');
    const [tiers, provisional] = [
      await getSetting(this.db, 'rating.tiers'),
      await getSetting(this.db, 'rating.provisional_deviation'),
    ];
    const rows = await this.db
      .select({
        sport: sports.name,
        slug: sports.slug,
        rating: ratings.rating,
        deviation: ratings.deviation,
        games: ratings.games,
      })
      .from(ratings)
      .innerJoin(sports, eq(sports.id, ratings.sportId))
      .where(and(eq(ratings.userId, playerId), eq(ratings.kind, 'skill')))
      .orderBy(desc(ratings.games));
    const [stars] = await this.db
      .select({ average: sql<number | null>`avg(${reviews.stars})::float`, count: sql<number>`count(*)::int` })
      .from(reviews)
      .where(eq(reviews.toUserId, playerId));
    const tags = await this.db
      .select({ tag: sql<string>`t.tag`, count: sql<number>`count(*)::int` })
      .from(sql`${reviews}, unnest(${reviews.tags}) as t(tag)`)
      .where(eq(reviews.toUserId, playerId))
      .groupBy(sql`t.tag`)
      .orderBy(sql`count(*) desc`)
      .limit(3);
    const [played] = await this.db
      .select({ n: sql<number>`count(distinct ${matches.id})::int` })
      .from(matches)
      .leftJoin(matchPlayers, eq(matchPlayers.matchId, matches.id))
      .where(
        and(
          eq(matches.status, 'completed'),
          sql`(${matches.hostId} = ${playerId} or (${matchPlayers.userId} = ${playerId} and ${matchPlayers.status} = 'confirmed'))`,
        ),
      );
    const [verified] = await this.db
      .select({ id: verifications.id })
      .from(verifications)
      .where(and(eq(verifications.userId, playerId), eq(verifications.status, 'approved')))
      .limit(1);
    return {
      id: u.id,
      name: u.name,
      city: u.city,
      verified: !!verified,
      matchesPlayed: Number(played?.n ?? 0),
      ratings: rows.map((r) => ({
        sport: r.sport,
        slug: r.slug,
        rating: Math.round(r.rating),
        provisional: r.deviation > provisional,
        tier: r.deviation > provisional ? null : tierFor(r.rating, tiers),
        games: r.games,
      })),
      behaviour: {
        average: stars?.average === null || stars?.average === undefined ? null : Math.round(stars.average * 10) / 10,
        count: Number(stars?.count ?? 0),
        topTags: tags.map((t) => ({ tag: t.tag, count: Number(t.count) })),
      },
    };
  }

  /** Top settled players for a sport. Provisional players are left out until their deviation settles. */
  // ponytail: computed per request from ratings_leaderboard_idx; cache it in a job table once traffic needs it.
  async leaderboard(sportSlug: string, city?: string) {
    const [sport] = await this.db.select({ id: sports.id }).from(sports).where(eq(sports.slug, sportSlug));
    if (!sport) throw new ResultError('NOT_FOUND', 'Sport not found.');
    const [tiers, provisional] = [
      await getSetting(this.db, 'rating.tiers'),
      await getSetting(this.db, 'rating.provisional_deviation'),
    ];
    const rows = await this.db
      .select({ id: users.id, name: users.name, city: users.city, rating: ratings.rating, games: ratings.games })
      .from(ratings)
      .innerJoin(users, eq(users.id, ratings.userId))
      .where(
        and(
          eq(ratings.sportId, sport.id),
          eq(ratings.kind, 'skill'),
          lte(ratings.deviation, provisional),
          inArray(users.status, ['active', 'pending_verification']),
          city ? ilike(users.city, city) : undefined,
        ),
      )
      .orderBy(desc(ratings.rating), asc(users.name))
      .limit(50);
    return rows.map((r, i) => ({
      rank: i + 1,
      id: r.id,
      name: r.name ?? 'Player',
      city: r.city,
      rating: Math.round(r.rating),
      tier: tierFor(r.rating, tiers),
      games: r.games,
    }));
  }
}
