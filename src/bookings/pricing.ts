// Pure functions: local time, opening hours, slot price, advance. No database access here.

export type DayType = 'weekday' | 'weekend' | 'holiday' | 'all';

export interface PriceRule {
  dayType: DayType;
  startTime: string; // 'HH:MM' or 'HH:MM:SS', venue local time
  endTime: string; // '00:00' means end of day
  pricePerHour: number; // minor units
}

export interface OpeningHours {
  weekday: number; // 0 = Sunday
  opensAt: string;
  closesAt: string; // earlier than or equal to opensAt means it closes after midnight
}

export interface LocalMoment {
  date: string; // YYYY-MM-DD
  weekday: number;
  minutes: number; // minutes since local midnight
}

const toMinutes = (t: string): number => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function toLocal(instant: Date, timeZone: string): LocalMoment {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(parts.weekday as string),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// True if the whole booking fits inside one opening window, including windows that run past midnight.
export function isWithinOpeningHours(start: Date, end: Date, timeZone: string, hours: OpeningHours[]): boolean {
  const s = toLocal(start, timeZone);
  const durationMin = (end.getTime() - start.getTime()) / 60_000;
  for (const h of hours) {
    const open = toMinutes(h.opensAt);
    let close = toMinutes(h.closesAt);
    if (close <= open) close += 24 * 60;
    // Window opening today.
    if (h.weekday === s.weekday && s.minutes >= open && s.minutes + durationMin <= close) return true;
    // Window that opened yesterday and runs past midnight.
    if (h.weekday === (s.weekday + 6) % 7 && close > 24 * 60) {
      const startInYesterday = s.minutes + 24 * 60;
      if (startInYesterday >= open && startInYesterday + durationMin <= close) return true;
    }
  }
  return false;
}

const DAY_TYPE_PRIORITY: Record<DayType, number> = { holiday: 3, weekend: 2, weekday: 2, all: 1 };

function rateAt(local: LocalMoment, rules: PriceRule[], isHoliday: boolean, weekendDays: readonly number[]): number {
  const isWeekend = weekendDays.includes(local.weekday);
  const matches = rules.filter((r) => {
    const dayOk =
      r.dayType === 'all' ||
      (r.dayType === 'holiday' && isHoliday) ||
      (r.dayType === 'weekend' && isWeekend && !isHoliday) ||
      (r.dayType === 'weekday' && !isWeekend && !isHoliday);
    if (!dayOk) return false;
    const from = toMinutes(r.startTime);
    const to = toMinutes(r.endTime) || 24 * 60;
    return local.minutes >= from && local.minutes < to;
  });
  const best = matches.sort((a, b) => DAY_TYPE_PRIORITY[b.dayType] - DAY_TYPE_PRIORITY[a.dayType])[0];
  if (!best) throw new NoPriceError(local);
  return best.pricePerHour;
}

// ponytail: prices in fixed steps (default 15 min), so a slot crossing a peak boundary is charged per part.
export function calculatePrice(
  start: Date,
  end: Date,
  timeZone: string,
  rules: PriceRule[],
  holidays: ReadonlySet<string>,
  weekendDays: readonly number[],
  stepMinutes = 15,
): number {
  const stepMs = stepMinutes * 60_000;
  let totalTimesSteps = 0;
  for (let t = start.getTime(); t < end.getTime(); t += stepMs) {
    const local = toLocal(new Date(t), timeZone);
    totalTimesSteps += rateAt(local, rules, holidays.has(local.date), weekendDays);
  }
  // Sum of hourly rates per step, divided by steps per hour. Rounded once to avoid drift.
  return Math.round((totalTimesSteps * stepMinutes) / 60);
}

export function calculateAdvance(total: number, type: 'fixed' | 'percentage' | 'none', value: number): number {
  if (type === 'none') return 0;
  if (type === 'fixed') return Math.min(value, total);
  return Math.round((total * value) / 10_000); // value in basis points
}

export class NoPriceError extends Error {
  constructor(public readonly at: LocalMoment) {
    super(`No price rule covers ${at.date} at minute ${at.minutes}`);
  }
}

/** The instant at which the venue's wall clock shows `date` (YYYY-MM-DD) plus `minutes` (may exceed 24 h). */
export function localToInstant(date: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d) + minutes * 60_000;
  const local = toLocal(new Date(guess), timeZone);
  const [ly, lm, ld] = local.date.split('-').map(Number) as [number, number, number];
  const offset = Date.UTC(ly, lm - 1, ld) + local.minutes * 60_000 - guess;
  return new Date(guess - offset);
}

/** Slot start and end minutes (from local midnight of `weekday`) inside that day's opening windows. */
export function slotTimes(weekday: number, hours: OpeningHours[], slotMinutes: number): [number, number][] {
  const slots: [number, number][] = [];
  for (const h of hours.filter((x) => x.weekday === weekday)) {
    const open = toMinutes(h.opensAt);
    let close = toMinutes(h.closesAt);
    if (close <= open) close += 24 * 60;
    for (let start = open; start + slotMinutes <= close; start += slotMinutes) slots.push([start, start + slotMinutes]);
  }
  return slots.sort((a, b) => a[0] - b[0]);
}
