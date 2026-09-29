import { glicko2 } from 'glicko2-lite';

export interface Glicko {
  rating: number;
  deviation: number;
  volatility: number;
}

const SCALE = 173.7178; // Glickman: public scale to Glicko-2 scale

/**
 * Idle players' deviation grows once per idle period (Glicko-2 step 6 for a period with no games), capped at the
 * start deviation, so returning players move faster (spec 11.2).
 */
export function idle(p: Glicko, periods: number, maxDeviation: number): Glicko {
  if (periods <= 0) return p;
  const phi = p.deviation / SCALE;
  const grown = Math.sqrt(phi * phi + periods * p.volatility * p.volatility) * SCALE;
  return { ...p, deviation: Math.min(grown, maxDeviation) };
}

/**
 * Team sports (spec 11.3): a side is its members' mean rating, with the deviations combined as a root mean square.
 * A single player is their own composite.
 */
export function composite(side: Glicko[]): Glicko {
  const n = side.length;
  return {
    rating: side.reduce((s, p) => s + p.rating, 0) / n,
    deviation: Math.sqrt(side.reduce((s, p) => s + p.deviation * p.deviation, 0) / n),
    volatility: side.reduce((s, p) => s + p.volatility, 0) / n,
  };
}

/** One game is one rating period (spec 11.2). score: 1 win, 0.5 draw, 0 loss. `damp` shrinks the rating change. */
export function rate(p: Glicko, opponent: Glicko, score: number, tau: number, damp = 1): Glicko {
  const next = glicko2(p.rating, p.deviation, p.volatility, [[opponent.rating, opponent.deviation, score]], { tau });
  return { rating: p.rating + (next.rating - p.rating) * damp, deviation: next.rd, volatility: next.vol };
}

export { glicko2 };
