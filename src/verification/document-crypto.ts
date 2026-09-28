import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 1; // First byte of every ciphertext, so keys can be rotated later.

/**
 * Field-level encryption for identity documents (spec 16): AES-256-GCM, with separate keys for
 * document numbers and images, and a keyed hash (HMAC) for duplicate detection. A plain hash of a
 * 13-digit number could be brute-forced; the HMAC cannot without the key.
 * Vendor payment account numbers use their own derived key too.
 */
export class DocumentCrypto {
  private readonly numberKey: Buffer;
  private readonly imageKey: Buffer;
  private readonly hashKey: Buffer;
  private readonly accountKey: Buffer;

  constructor(masterKeyBase64: string) {
    const master = Buffer.from(masterKeyBase64, 'base64');
    if (master.length !== 32) throw new Error('DOCUMENT_KEY must be 32 bytes');
    const derive = (purpose: string) => Buffer.from(hkdfSync('sha256', master, '', `sportslink:${purpose}`, 32));
    this.numberKey = derive('document-number');
    this.imageKey = derive('document-image');
    this.hashKey = derive('document-hash');
    this.accountKey = derive('payment-account');
  }

  encryptNumber = (docNumber: string) => this.encrypt(this.numberKey, Buffer.from(docNumber)).toString('base64');
  decryptNumber = (stored: string) => this.decrypt(this.numberKey, Buffer.from(stored, 'base64')).toString();
  encryptImage = (image: Buffer) => this.encrypt(this.imageKey, image);
  decryptImage = (stored: Buffer) => this.decrypt(this.imageKey, stored);
  encryptAccount = (accountNumber: string) =>
    this.encrypt(this.accountKey, Buffer.from(accountNumber)).toString('base64');
  decryptAccount = (stored: string) => this.decrypt(this.accountKey, Buffer.from(stored, 'base64')).toString();
  hashNumber = (docNumber: string) => createHmac('sha256', this.hashKey).update(docNumber).digest('hex');

  private encrypt(key: Buffer, plain: Buffer) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  private decrypt(key: Buffer, stored: Buffer) {
    if (stored[0] !== VERSION) throw new Error('Unknown document encryption version');
    const decipher = createDecipheriv('aes-256-gcm', key, stored.subarray(1, 13));
    decipher.setAuthTag(stored.subarray(13, 29));
    return Buffer.concat([decipher.update(stored.subarray(29)), decipher.final()]);
  }
}
