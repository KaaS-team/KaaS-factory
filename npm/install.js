// Downloads the release binary for this platform and checks it against the release's SHA256SUMS.
// Plain Node, no dependencies: it runs from a postinstall hook on a machine that has only npm.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASES = "https://github.com/KaaS-team/KaaS-factory/releases/download";

export function assetName(platform, arch) {
  const os = { darwin: "darwin", linux: "linux" }[platform];
  const cpu = { arm64: "arm64", x64: "x64" }[arch];
  if (!os || !cpu) throw new Error(`no factory binary for ${platform}/${arch}`);
  return `factory-${os}-${cpu}`;
}

// SHA256SUMS lines are `<hex>  <file>`, as `sha256sum` writes them.
export function expectedSum(sums, file) {
  for (const line of sums.split("\n")) {
    const [hex, name] = line.trim().split(/\s+/);
    if (name === file && /^[0-9a-f]{64}$/i.test(hex ?? "")) return hex.toLowerCase();
  }
  throw new Error(`SHA256SUMS has no entry for ${file}`);
}

export function verifyChecksum(bytes, sums, file) {
  const want = expectedSum(sums, file);
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) throw new Error(`checksum mismatch for ${file}: expected ${want}, got ${got}`);
}

/** @param {(url: string) => Promise<Response>} fetchFn */
async function get(fetchFn, url) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// The binary reaches `dest` only after its checksum passes.
/** @param {{ version: string, dest: string, platform?: string, arch?: string, fetchFn?: (url: string) => Promise<Response> }} opts */
export async function install({ version, dest, platform = process.platform, arch = process.arch, fetchFn = fetch }) {
  const file = assetName(platform, arch);
  const base = `${RELEASES}/v${version}`;
  const [bin, sums] = await Promise.all([get(fetchFn, `${base}/${file}`), get(fetchFn, `${base}/SHA256SUMS`)]);
  verifyChecksum(bin, sums.toString("utf8"), file);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  writeFileSync(tmp, bin);
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
  return dest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
  install({ version, dest: join(here, "bin", "factory-bin") }).catch((e) => {
    console.error(`factory install failed: ${e.message}`);
    process.exit(1);
  });
}
