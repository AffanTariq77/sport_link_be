import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export const STORAGE = Symbol('STORAGE');

/** Private object storage. Callers encrypt sensitive data before `put`. */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
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

  private path(key: string) {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return path;
  }
}
