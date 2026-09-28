/** True if a Postgres error with this SQLSTATE is anywhere in the cause chain (Drizzle wraps pg errors). */
export function hasPgCode(err: unknown, code: string) {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === code) return true;
  }
  return false;
}

export const UNIQUE_VIOLATION = '23505';
