/** Bracket positions for seeds 1..size so the top seeds meet last: 1 v 8, 4 v 5, 2 v 7, 3 v 6. */
export function seedOrder(size: number) {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order.slice(0, Math.max(size, 1));
}

export const nextPowerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(n, 2)));

/** Circle method: every entrant meets every other once. null = a bye in that round. */
export function roundRobin<T>(entries: T[]): [T | null, T | null][][] {
  const list: (T | null)[] = entries.length % 2 ? [...entries, null] : [...entries];
  const n = list.length;
  const rounds: [T | null, T | null][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [T | null, T | null][] = [];
    for (let i = 0; i < n / 2; i++) pairs.push(r % 2 ? [list[n - 1 - i]!, list[i]!] : [list[i]!, list[n - 1 - i]!]);
    rounds.push(pairs);
    list.splice(1, 0, list.pop()!); // rotate all but the first
  }
  return rounds;
}

/** Seeds dealt into groups in a snake (1 2 3 4 / 8 7 6 5), so groups are balanced. */
export function snake<T>(seeded: T[], groups: number): T[][] {
  const out: T[][] = Array.from({ length: groups }, () => []);
  seeded.forEach((e, i) => {
    const row = Math.floor(i / groups);
    const col = i % groups;
    out[row % 2 ? groups - 1 - col : col]!.push(e);
  });
  return out;
}

export interface Played {
  entryA: string | null;
  entryB: string | null;
  scoreA: number | null;
  scoreB: number | null;
  winnerEntryId: string | null;
  status: string;
}

/** League table: points, then goal difference, then goals for. Walkovers count as a win without goals. */
export function standings(entries: string[], fixtures: Played[], points = { win: 3, draw: 1 }) {
  const rows = new Map(
    entries.map((id) => [id, { entryId: id, played: 0, won: 0, drawn: 0, lost: 0, for: 0, against: 0, points: 0 }]),
  );
  for (const f of fixtures) {
    if (!f.entryA || !f.entryB || (f.status !== 'completed' && f.status !== 'walkover')) continue;
    const a = rows.get(f.entryA);
    const b = rows.get(f.entryB);
    if (!a || !b) continue;
    a.played++;
    b.played++;
    if (f.status === 'completed') {
      a.for += f.scoreA ?? 0;
      a.against += f.scoreB ?? 0;
      b.for += f.scoreB ?? 0;
      b.against += f.scoreA ?? 0;
    }
    const winner = f.winnerEntryId;
    if (!winner) {
      a.drawn++;
      b.drawn++;
      a.points += points.draw;
      b.points += points.draw;
    } else {
      const [w, l] = winner === f.entryA ? [a, b] : [b, a];
      w.won++;
      l.lost++;
      w.points += points.win;
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, difference: r.for - r.against }))
    .sort((x, y) => y.points - x.points || y.difference - x.difference || y.for - x.for);
}
