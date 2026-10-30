// README.md may only name `factory` subcommands that exist, and only point at repo paths that exist.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../src/help";

const root = join(import.meta.dir, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

const codeBlocks = [...readme.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!);

describe("README accuracy", () => {
  test("every `factory <subcommand>` in a code block is in the command table", () => {
    const known = new Set(COMMANDS.map((c) => c.name));
    const named = codeBlocks.flatMap((b) =>
      [...b.matchAll(/(?:^|[\s/])factory[ \t]+([a-z][a-z-]*)/gm)].map((m) => m[1]!),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !known.has(n))).toEqual([]);
  });

  test("every relative link and repo path exists", () => {
    const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((l) => !/^([a-z]+:|#)/.test(l));
    const paths = [
      ...readme.matchAll(
        /`((?:src|docs|tests|template|template-ci|dashboard|relay|scripts|ee)\/[A-Za-z0-9_./-]+)(?![A-Za-z0-9_./{-])[^`]*`/g,
      ),
    ].map((m) => m[1]!);
    const targets = [...links, ...paths].map((p) => p.replace(/#.*$/, "").replace(/\/$/, ""));
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((p) => !existsSync(join(root, p)))).toEqual([]);
  });
});
