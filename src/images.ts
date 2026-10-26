// The container image a repo's gates run in, for a docker or ssh runtime whose image is "auto".
// A devcontainer's own image wins, then the repo's `toolchain` key, then the stack `factory init`
// detects; so a Python repo never runs its tests in a Node image.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectStack, diskFiles, type RepoFiles } from "./stack";

export const AUTO_IMAGE = "auto";

export const TOOLCHAIN_IMAGES = {
  node: "node:22-slim",
  bun: "oven/bun:1.3.4-slim",
  python: "python:3.12-slim",
  go: "golang:1.23",
  ruby: "ruby:3.3-slim",
  rust: "rust:1-slim",
} as const;
export type Toolchain = keyof typeof TOOLCHAIN_IMAGES;
export const TOOLCHAINS = Object.keys(TOOLCHAIN_IMAGES) as Toolchain[];

const STACK_TOOLCHAIN: Readonly<Record<string, Toolchain>> = {
  node: "node",
  npm: "node",
  pnpm: "node",
  yarn: "node",
  bun: "bun",
  uv: "python",
  poetry: "python",
  pip: "python",
  go: "go",
  ruby: "ruby",
  rails: "ruby",
  rust: "rust",
};

export function toolchainProblems(value: unknown): string[] {
  if (value === undefined || TOOLCHAINS.includes(value as Toolchain)) return [];
  return [`toolchain: expected one of ${TOOLCHAINS.join(", ")}, got ${JSON.stringify(value)}`];
}

export function toolchainOf(stack: string): Toolchain | undefined {
  return STACK_TOOLCHAIN[stack];
}

// devcontainer.json is JSONC; a `build.dockerfile` devcontainer has no image to name, so it falls through.
export function devcontainerImage(files: RepoFiles): string | undefined {
  for (const p of [".devcontainer/devcontainer.json", ".devcontainer.json"]) {
    const text = files.read(p);
    if (text === undefined) continue;
    try {
      const json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")) as { image?: unknown };
      if (typeof json.image === "string" && json.image) return json.image;
    } catch {}
  }
  return undefined;
}

export function imageFor(files: RepoFiles, toolchain?: string): string | undefined {
  const named = toolchain && Object.hasOwn(TOOLCHAIN_IMAGES, toolchain) ? (toolchain as Toolchain) : undefined;
  const chain = named ?? toolchainOf(detectStack(files).name);
  return devcontainerImage(files) ?? (chain ? TOOLCHAIN_IMAGES[chain] : undefined);
}

// Resolved per run from the worktree itself, so one machine runtime serves every repo it hosts.
export function resolveImage(image: string, cwd: string): string {
  if (image !== AUTO_IMAGE) return image;
  const config = join(cwd, ".factory", "config.json");
  let toolchain: string | undefined;
  try {
    if (existsSync(config)) toolchain = (JSON.parse(readFileSync(config, "utf8")) as { toolchain?: string }).toolchain;
  } catch {}
  return imageFor(diskFiles(cwd), toolchain) ?? TOOLCHAIN_IMAGES.node;
}
