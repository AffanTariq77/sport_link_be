# Security checklist

Status of spec section 16 and the Phase 1 requirement "security checklist and penetration test passed" (18.4).
Updated 28 September 2026.

## Done

| Area                   | What is in place                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets                | Nothing secret in code or the repo. `.env` is git-ignored, `.env.example` has no values. Development-only switches (`DEV_OTP_CODE`, `DEV_TOTP_CODE`, fake SMS, local storage) make the API refuse to start in production. CI runs gitleaks on every push        |
| Identity documents     | CNIC and B-Form numbers and images encrypted with AES-256-GCM before storage, separate keys derived from `DOCUMENT_KEY` per purpose, keyed hash (HMAC) for duplicate detection, never public; every admin view of a number or image is written to the audit log |
| Other sensitive fields | Vendor payment account numbers, walk-in customer phone numbers and admin two-factor secrets encrypted with their own derived keys                                                                                                                               |
| Phone numbers          | Never returned by a player-facing endpoint; vendors see a walk-in's phone only on their own manual bookings; chat warns before a number is shared and logs it                                                                                                   |
| Location               | Players' locations are not stored yet (Find Players is Phase 2); venues store their public business location only                                                                                                                                               |
| Authentication         | Phone OTP with resend timer, 5 attempts then 30 minute lockout and per-phone hourly limit; opaque session tokens stored as SHA-256 hashes; rotating refresh tokens with reuse detection; bans and suspensions revoke sessions at once                           |
| Admin                  | Separate sign-in with scrypt password plus mandatory TOTP, lockout after repeated failures, 8 hour sessions, granular role permissions as a setting, every action audit-logged in the same transaction, audit log append-only by database trigger               |
| Authorisation          | Every endpoint checks ownership or role; vendor staff scoped to their branches and permissions on every request; minors locked until guardian consent                                                                                                           |
| Money integrity        | Integer minor units only; database checks on amounts; one transaction reference per method; double booking impossible (exclusion constraint, tested with 25 simultaneous holds)                                                                                 |
| API protection         | Input validated with Zod on every endpoint; rate limit per IP (300 a minute, 20 a minute on sign-in); security headers; no CORS (browsers never call the API directly); API docs not served in production                                                       |
| Web apps               | Tokens in httpOnly cookies (never readable by page scripts), admin cookie `SameSite=Strict`; clickjacking and referrer headers; admin panel not indexed; document images streamed per view, never cached                                                        |
| Uploads                | Images checked by their content, not the file name; size limits in the API and at the web server                                                                                                                                                                |

## Still to do before public launch

1. Penetration test by an independent tester (spec 16). Not something the team can sign off itself.
2. HTTPS and a secrets manager in the deployed environment (for example AWS Secrets Manager); set `NODE_ENV=production`.
3. S3 storage driver with encryption at rest and a private bucket (only a local development driver exists).
4. Real SMS provider behind the `SmsSender` interface (provider choice is OPEN).
5. Rate limits shared across instances (Redis) and per-device limits once devices are registered.
6. Malware scanning of uploads and image re-encoding.
7. Backups with point-in-time recovery and a tested restore (spec 16).
8. Privacy policy covering CNIC, location, chat storage and ads; data export and deletion on request.
9. Legal review of the points in the Foundation Document section 11.
