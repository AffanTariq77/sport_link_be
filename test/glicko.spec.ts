import { describe, expect, it } from 'vitest';
import { composite, glicko2, idle, rate } from '../src/ratings/glicko.js';

describe('Glicko-2', () => {
  it("matches the worked example in Glickman's paper", () => {
    const r = glicko2(1500, 200, 0.06, [
      [1400, 30, 1],
      [1550, 100, 0],
      [1700, 300, 0],
    ]);
    expect(r.rating).toBeCloseTo(1464.06, 1);
    expect(r.rd).toBeCloseTo(151.52, 1);
    expect(r.vol).toBeCloseTo(0.05999, 4);
  });

  it('a win against an equal player raises the rating and narrows the deviation; damping shrinks the change', () => {
    const p = { rating: 1500, deviation: 350, volatility: 0.06 };
    const won = rate(p, p, 1, 0.5);
    expect(won.rating).toBeGreaterThan(1500);
    expect(won.deviation).toBeLessThan(350);
    const damped = rate(p, p, 1, 0.5, 0.5);
    expect(damped.rating - 1500).toBeCloseTo((won.rating - 1500) / 2, 6);
    expect(rate(p, p, 0.5, 0.5).rating).toBeCloseTo(1500, 6);
  });

  it('idle periods grow the deviation up to the cap; sides combine members', () => {
    const p = { rating: 1600, deviation: 60, volatility: 0.06 };
    expect(idle(p, 0, 350)).toEqual(p);
    expect(idle(p, 12, 350).deviation).toBeGreaterThan(60);
    expect(idle(p, 1e6, 350).deviation).toBe(350);
    expect(composite([p, { rating: 1400, deviation: 80, volatility: 0.06 }])).toEqual({
      rating: 1500,
      deviation: Math.sqrt((60 * 60 + 80 * 80) / 2),
      volatility: 0.06,
    });
  });
});
