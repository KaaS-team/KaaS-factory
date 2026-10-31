import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionHashInput, connectionProblems } from "../src/mc/connections";
import { loadMachineConfig } from "../src/machine";

const good = { connections: { gh: { kind: "github", tokenEnv: "GH_TOKEN", url: "https://api.github.com" } } };

describe("connectionProblems", () => {
  test("a good connection has none", () => expect(connectionProblems(good)).toEqual([]));

  test("absent sessions has none", () => expect(connectionProblems(undefined)).toEqual([]));

  test("a token value is refused, and the value is not echoed", () => {
    const p = connectionProblems({ connections: { gh: { kind: "github", token: "ghp_abc123secretvalue" } } });
    expect(p.length).toBe(1);
    expect(p[0]).toContain("never the value");
    expect(p.join()).not.toContain("ghp_abc123secretvalue");
  });

  test("password, secret and key values are refused too", () => {
    for (const k of ["password", "webhookSecret", "apiKey"])
      expect(connectionProblems({ connections: { a: { kind: "x", [k]: "v" } } }).length).toBe(1);
  });

  test("a lower-case env name is refused", () => {
    const p = connectionProblems({ connections: { gh: { kind: "github", tokenEnv: "gh_token" } } });
    expect(p[0]).toContain("tokenEnv");
  });

  test("a bad connection name is refused", () => {
    expect(connectionProblems({ connections: { "Bad Name": { kind: "x" } } }).length).toBe(1);
  });

  test("an http url is refused, loopback http needs allowPrivate", () => {
    expect(connectionProblems({ connections: { a: { kind: "x", url: "http://api.test" } } }).length).toBe(1);
    expect(connectionProblems({ connections: { a: { kind: "x", url: "http://localhost:80" } } }).length).toBe(1);
    expect(
      connectionProblems({ connections: { a: { kind: "x", url: "http://localhost:80", allowPrivate: true } } }),
    ).toEqual([]);
  });
});

describe("connectionHashInput", () => {
  test("is the same whether or not the variable is set", () => {
    const conns = good.connections;
    const before = JSON.stringify(connectionHashInput(conns));
    process.env.GH_TOKEN = "ghp_value-that-must-not-matter";
    try {
      expect(JSON.stringify(connectionHashInput(conns))).toBe(before);
    } finally {
      delete process.env.GH_TOKEN;
    }
    expect(before).toContain("GH_TOKEN");
    expect(before).not.toContain("ghp_value");
  });
});

describe("machine.json sessions", () => {
  function load(sessions: unknown): () => unknown {
    // The preload removes its shared temp root after each rerun, so recreate the parent first.
    mkdirSync(tmpdir(), { recursive: true });
    const home = mkdtempSync(join(tmpdir(), "factory-mc-conn-"));
    writeFileSync(join(home, "machine.json"), JSON.stringify({ slots: 2, sessions }));
    return () => {
      try {
        return loadMachineConfig({ FACTORY_HOME: home });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    };
  }

  test("a good sessions key loads", () => {
    expect((load(good)() as { sessions: unknown }).sessions).toEqual(good);
  });

  test("a token value refuses to boot", () => {
    expect(load({ connections: { gh: { kind: "github", token: "ghp_x" } } })).toThrow("never the value");
  });
});
