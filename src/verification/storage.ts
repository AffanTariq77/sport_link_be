import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { dirname, join, resolve, sep } from 'node:path';

export const STORAGE = Symbol('STORAGE');

/** Private object storage. Callers encrypt sensitive data before `put`. */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Content type from the file's first bytes, never the client's claim. Null if not a JPEG, PNG or WebP. */
export function imageType(b: Buffer) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg' as const;
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png' as const;
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp' as const;
  return null;
}

/**
 * Any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO). The bucket must be private: CNIC images and venue photos
 * are both served through the API. Credentials come from the standard AWS chain (environment, profile or role).
 */
export class S3Storage implements FileStorage {
  private readonly s3: S3Client;
  constructor(
    private readonly bucket: string,
    opts: { region: string; endpoint?: string },
  ) {
    this.s3 = new S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: !!opts.endpoint });
  }

  async put(key: string, data: Buffer) {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ServerSideEncryption: 'AES256' }),
    );
  }

  async get(key: string) {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Development only: a local folder. Config refuses it in production. */
export class LocalDiskStorage implements FileStorage {
  private readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }

  async put(key: string, data: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  get(key: string) {
    return readFile(this.path(key));
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }

  private path(key: string) {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return path;
  }
}
