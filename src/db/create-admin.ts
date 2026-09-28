// Creates an admin: pnpm admin:create <email> "<name>" <role>. Prints the two-factor secret to add to an
// authenticator app. The password comes from ADMIN_PASSWORD, or a random one is generated and printed once.
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../admin/password.js';
import { newTotpSecret, otpauthUri } from '../admin/totp.js';
import { loadEnv } from '../config.js';
import { DocumentCrypto } from '../verification/document-crypto.js';
import { createDb } from './client.js';
import { adminRole, adminUsers } from './schema.js';

const [email, name, role] = process.argv.slice(2);
if (!email || !name || !adminRole.enumValues.includes(role as never)) {
  console.error(`Usage: pnpm admin:create <email> "<name>" <${adminRole.enumValues.join('|')}>`);
  process.exit(1);
}
const env = loadEnv();
const password = process.env.ADMIN_PASSWORD ?? randomBytes(18).toString('base64url');
const secret = newTotpSecret();
const { db, pool } = createDb(env.DATABASE_URL);
await db.insert(adminUsers).values({
  email: email.toLowerCase(),
  name,
  role: role as (typeof adminRole.enumValues)[number],
  passwordHash: await hashPassword(password),
  totpSecretEncrypted: new DocumentCrypto(env.DOCUMENT_KEY).encryptTotp(secret),
});
await pool.end();
console.log(`Admin ${email} created with role ${role}.`);
if (!process.env.ADMIN_PASSWORD) console.log(`Password (shown once): ${password}`);
console.log(`Two-factor secret: ${secret}\nAuthenticator link: ${otpauthUri(secret, email)}`);
