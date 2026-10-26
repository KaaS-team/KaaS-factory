// The local-disk blob store: one file per key under a root directory.
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { type BlobEntry, type BlobStore, validBlobKey } from "../../ports/blob";

export class DiskBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    if (!validBlobKey(key)) throw new Error(`invalid blob key ${JSON.stringify(key)}`);
    return join(this.root, key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, body);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const file = Bun.file(this.path(key));
    return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : undefined;
  }

  async list(prefix: string): Promise<readonly BlobEntry[]> {
    const names = await readdir(this.root, { recursive: true }).catch(() => [] as string[]);
    const out: BlobEntry[] = [];
    for (const name of names) {
      const key = name.split(sep).join("/");
      if (!key.startsWith(prefix)) continue;
      const s = await stat(join(this.root, name));
      if (s.isFile()) out.push({ key, size: s.size });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
}
