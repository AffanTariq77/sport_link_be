import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
// OWASP-recommended scrypt cost (N=2^17, r=8, p=1). Stored as scrypt$N$r$p$salt$hash so it can change later.
const N = 2 ** 17;
const R = 8;
const P = 1;
const opts = (n: number, r: number, p: number) => ({ N: n, r, p, maxmem: 256 * n * r });

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, opts(N, R, P));
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, opts(+n!, +r!, +p!));
  return timingSafeEqual(actual, expected);
}
