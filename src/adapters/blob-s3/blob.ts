// The S3-compatible blob store (Cloudflare R2, MinIO, AWS) on Bun's built-in S3 client, so no SDK.
import type { S3Client } from "bun";
import { type BlobEntry, type BlobStore, validBlobKey } from "../../ports/blob";

export class S3BlobStore implements BlobStore {
  constructor(private readonly client: S3Client) {}

  private checked(key: string): string {
    if (!validBlobKey(key)) throw new Error(`invalid blob key ${JSON.stringify(key)}`);
    return key;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.client.write(this.checked(key), body);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const file = this.client.file(this.checked(key));
    if (!(await file.exists())) return undefined;
    return new Uint8Array(await file.arrayBuffer());
  }

  async list(prefix: string): Promise<readonly BlobEntry[]> {
    const out: BlobEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.list({ prefix, ...(continuationToken ? { continuationToken } : {}) });
      for (const o of page.contents ?? []) out.push({ key: o.key, size: o.size ?? 0 });
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
    return out;
  }
}
