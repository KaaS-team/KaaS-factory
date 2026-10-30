// Builds the standalone `factory` binary with template/ and template-ci/ embedded.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-arm64", "bun-linux-x64"] as const;
export type Target = (typeof TARGETS)[number];

const root = resolve(import.meta.dir, "..");

export const hostTarget = (): string => `bun-${process.platform}-${process.arch}`;

function walk(dir: string, prefix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = `${prefix}/${e.name}`;
    return e.isDirectory() ? walk(join(dir, e.name), rel) : [rel];
  });
}

export function embeddedFiles(): Record<string, string> {
  const keys = ["template", "template-ci"].flatMap((top) => walk(join(root, top), top)).sort();
  return Object.fromEntries(keys.map((k) => [k, readFileSync(join(root, k)).toString("base64")]));
}

export async function buildBinary(target: string, outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, "src", "cli.ts")],
    compile: { target, outfile } as never,
    define: { FACTORY_EMBEDDED_TEMPLATE: JSON.stringify(embeddedFiles()) },
  });
  if (!result.success) throw new Error(`build ${target} failed:\n${result.logs.map(String).join("\n")}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? undefined : args[i + 1];
  };
  const out = resolve(flag("out") ?? "dist");
  const targets = args.includes("--host") ? [hostTarget()] : flag("target") ? [flag("target")!] : [...TARGETS];
  for (const t of targets) {
    const [, os, arch] = t.split("-");
    const outfile = join(out, `factory-${os}-${arch}`);
    await buildBinary(t, outfile);
    console.log(`build-binary: ${outfile}`);
  }
}
