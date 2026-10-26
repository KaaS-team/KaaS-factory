// Per-language images: a docker or ssh runtime with image "auto" runs each repo's gates in that repo's
// own language image, from its devcontainer first, then its `toolchain` key, then its detected stack.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerArgs } from "../src/adapters/docker/execution";
import { sshArgs } from "../src/adapters/ssh/execution";
import { configProblems } from "../src/config";
import { resolveImage, TOOLCHAIN_IMAGES } from "../src/images";
import { runtimeProblems } from "../src/runtimes";

function repo(stack: string, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `factory-img-${stack}-`));
  cpSync(join(import.meta.dir, "fixtures/stacks", stack), dir, { recursive: true });
  for (const [p, body] of Object.entries(extra)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

describe("language images", () => {
  test("an auto image follows the devcontainer, then the toolchain key, then the stack, for docker and ssh", () => {
    expect(resolveImage("auto", repo("uv"))).toBe(TOOLCHAIN_IMAGES.python);
    expect(resolveImage("auto", repo("go"))).toBe(TOOLCHAIN_IMAGES.go);
    expect(resolveImage("auto", repo("bun"))).toBe(TOOLCHAIN_IMAGES.bun);
    expect(resolveImage("auto", repo("docs"))).toBe(TOOLCHAIN_IMAGES.node);
    expect(resolveImage("ubuntu:24.04", repo("uv"))).toBe("ubuntu:24.04");
    const keyed = repo("uv", { ".factory/config.json": JSON.stringify({ toolchain: "rust" }) });
    expect(resolveImage("auto", keyed)).toBe(TOOLCHAIN_IMAGES.rust);
    const dev = repo("uv", {
      ".factory/config.json": JSON.stringify({ toolchain: "rust" }),
      ".devcontainer/devcontainer.json": '{\n  // the team image\n  "image": "ghcr.io/acme/dev:3",\n}\n',
    });
    expect(resolveImage("auto", dev)).toBe("ghcr.io/acme/dev:3");

    const py = repo("uv");
    expect(containerArgs({ kind: "docker", image: "auto" }, "pytest", py)).toContain(TOOLCHAIN_IMAGES.python);
    const ssh = sshArgs({ kind: "ssh", host: "build-1", dir: "/w", image: "auto" }, "pytest", py);
    expect(ssh.run.at(-1)).toContain(`'docker' 'run' '--rm'`);
    expect(ssh.run.at(-1)).toContain(`'${TOOLCHAIN_IMAGES.python}' 'bash' '-c' 'pytest'`);
    expect(sshArgs({ kind: "ssh", host: "build-1", dir: "/w" }, "pytest", py).run.at(-1)).not.toContain("docker");
    expect(runtimeProblems({ b: { kind: "ssh", host: "h", dir: "/w", image: "auto" } })).toEqual([]);
    expect(configProblems({ toolchain: "cobol" })).toEqual([
      `toolchain: expected one of ${Object.keys(TOOLCHAIN_IMAGES).join(", ")}, got "cobol"`,
    ]);
  });
});
