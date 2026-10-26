// Where transcripts and stage artifacts go so the plane can show them, not only the machine that ran
// the stage. A directory is one adapter (one box, or a shared mount); an S3-compatible bucket is the other.

export interface BlobEntry {
  readonly key: string;
  readonly size: number;
}

export interface BlobStore {
  put(key: string, body: Uint8Array): Promise<void>;
  // Undefined when nothing is stored under the key.
  get(key: string): Promise<Uint8Array | undefined>;
  // Every key under the prefix with its size, so a mirror copies only what changed.
  list(prefix: string): Promise<readonly BlobEntry[]>;
}

// Keys are `owner/name/issue-N/...`: plain segments only, so no key can climb out of a directory.
export function validBlobKey(key: string): boolean {
  const parts = key.split("/");
  return parts.length > 0 && parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== "..");
}
