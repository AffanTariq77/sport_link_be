/**
 * Normalises a mobile number to E.164 and finds its country.
 * Pakistan only at launch: 03xx xxxxxxx, +92 3xx xxxxxxx, 0092 or 92 prefixes, spaces and dashes allowed.
 * Add a country's pattern here when that country is enabled.
 */
export function normalisePhone(input: string): { phone: string; countryCode: string } | null {
  const m = /^(?:\+92|0092|92|0)(3\d{9})$/.exec(input.replace(/[\s-]/g, ''));
  return m ? { phone: `+92${m[1]}`, countryCode: 'PK' } : null;
}
