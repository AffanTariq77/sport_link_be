import { describe, expect, it } from 'vitest';
import { nextPowerOfTwo, roundRobin, seedOrder, snake, standings } from '../src/tournaments/bracket.js';

describe('draws', () => {
  it('seeds a knockout so the top seeds meet last', () => {
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect([nextPowerOfTwo(5), nextPowerOfTwo(8), nextPowerOfTwo(1)]).toEqual([8, 8, 2]);
  });

  it('round robin meets everyone once, with a bye for an odd count', () => {
    const rounds = roundRobin(['a', 'b', 'c', 'd', 'e']);
    expect(rounds).toHaveLength(5);
    const pairs = rounds
      .flat()
      .filter(([x, y]) => x && y)
      .map(([x, y]) => [x, y].sort().join(''));
    expect(new Set(pairs).size).toBe(10);
    expect(pairs).toHaveLength(10);
  });

  it('snakes seeds into balanced groups', () => {
    expect(snake([1, 2, 3, 4, 5, 6, 7, 8], 2)).toEqual([
      [1, 4, 5, 8],
      [2, 3, 6, 7],
    ]);
  });

  it('orders a table by points, goal difference, then goals', () => {
    const f = (a: string, b: string, sa: number, sb: number) => ({
      entryA: a,
      entryB: b,
      scoreA: sa,
      scoreB: sb,
      winnerEntryId: sa > sb ? a : sb > sa ? b : null,
      status: 'completed',
    });
    const table = standings(['x', 'y', 'z'], [f('x', 'y', 2, 0), f('y', 'z', 1, 1), f('z', 'x', 3, 1)]);
    expect(table.map((r) => [r.entryId, r.points, r.difference])).toEqual([
      ['z', 4, 2],
      ['x', 3, 0],
      ['y', 1, -2],
    ]);
  });
});
