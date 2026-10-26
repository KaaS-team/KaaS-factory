import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  association,
  decodeBody,
  encodeBody,
  IdMap,
  keyNumber,
  VendorClient,
  workspaceRole,
} from "../src/adapters/trackers/kit";

// The runner's seal; adapters key it with the tracker token.
const seal = (s: string) => createHmac("sha256", "tracker-token").update(s).digest("hex").slice(0, 32);
const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

describe("marker footer codec", () => {
  const body =
    '<!-- factory:plan v1 rev=2 -->\nThe plan\n\n<!-- factory:data v1 -->\n```json\n{"a": 1}\n```\nnaïve ✓\n';

  test("a body round-trips byte for byte through a tracker that drops HTML comments", () => {
    const stored = stripComments(encodeBody(body, seal, "comment"));
    expect(stored).not.toContain("<!--");
    expect(stored.startsWith("The plan")).toBe(true);
    expect(decodeBody(stored, true, seal, "comment")).toBe(body);
  });

  test("a tracker that re-renders the markdown or escapes the footer still decodes", () => {
    const stored = encodeBody(body, seal, "comment")
      .replace("The plan", "The *plan*")
      .replace(/_/g, "\\_")
      .replace(/factory-data: (.)/, "factory-data: \\$1");
    expect(decodeBody(stored, true, seal, "comment")).toBe(body);
  });

  test("a body with no marker is sent as is, and plain text decodes to itself", () => {
    expect(encodeBody("just text", seal, "comment")).toBe("just text");
    expect(decodeBody("just text\n", true, seal, "comment")).toBe("just text\n");
  });

  test("a human edit above the footer wins over the stale copy, without the footer line", () => {
    const stored = encodeBody(body, seal, "comment").replace("The plan", "A different plan");
    expect(decodeBody(stored, true, seal, "comment")).toBe(
      stored.slice(0, stored.lastIndexOf("factory-data: ")).trimEnd(),
    );
  });

  test("a footer that is not ours is left alone", () => {
    expect(decodeBody("x\n\nfactory-data: not!base64", true, seal, "comment")).toBe("x\n\nfactory-data: not!base64");
  });

  test("a footer sealed with another key reads as its visible text, even on the runner's own content", () => {
    const other = (s: string) => createHmac("sha256", "not-the-token").update(s).digest("hex").slice(0, 32);
    const forged = encodeBody(body, other, "comment");
    expect(decodeBody(forged, true, seal, "comment")).toBe(
      forged.slice(0, forged.lastIndexOf("factory-data: ")).trimEnd(),
    );
  });

  test("a sealed comment pasted into a description reads as its visible text there", () => {
    const stored = encodeBody(body, seal, "comment");
    expect(decodeBody(stored, true, seal, "comment")).toBe(body);
    expect(decodeBody(stored, true, seal, "description")).toBe(
      stored.slice(0, stored.lastIndexOf("factory-data: ")).trimEnd(),
    );
  });

  test("a valid footer someone else wrote stays as written, so an outsider cannot hide text", () => {
    const stored = encodeBody(body, seal, "comment");
    expect(decodeBody(stored, false, seal, "comment")).toBe(stored);
  });
});

describe("the footer seal", () => {
  test("is keyed by the tracker token, so a different token gives a different seal", () => {
    const client = (token: string) => new VendorClient("x", "http://x", "T", () => ({}), { T: token });
    expect(client("a").seal("body")).toBe(client("a").seal("body"));
    expect(client("a").seal("body")).not.toBe(client("b").seal("body"));
    expect(() => client("").seal("body")).toThrow("env var T is not set");
  });
});

describe("ids, roles and keys", () => {
  test("a vendor id maps to a stable positive safe integer and back", () => {
    const ids = new IdMap();
    const n = ids.number("8f4c2b1e-0d3a-4f7b-9c21-6e5a8b7d4f13");
    expect(Number.isSafeInteger(n) && n > 0).toBe(true);
    expect(new IdMap().number("8f4c2b1e-0d3a-4f7b-9c21-6e5a8b7d4f13")).toBe(n);
    expect(ids.vendorId(n)).toBe("8f4c2b1e-0d3a-4f7b-9c21-6e5a8b7d4f13");
    expect(ids.vendorId(n + 1)).toBeUndefined();
  });

  test("only admins and members are trusted, and keys give their number", () => {
    expect(["admin", "member", "guest", "none"].map((t) => association(workspaceRole(t as "admin")))).toEqual([
      "OWNER",
      "MEMBER",
      "NONE",
      "NONE",
    ]);
    expect(keyNumber("ENG-42")).toBe(42);
    expect(() => keyNumber("ENG")).toThrow("not an issue key");
  });
});

describe("VendorClient", () => {
  test("reads the token from the env per call, and an error names the path but not the query", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        req.headers.get("x-key") === "s3cret" ? Response.json({ ok: true }) : new Response("denied", { status: 401 }),
    });
    const env: Record<string, string | undefined> = {};
    const client = new VendorClient(
      "acme",
      `http://127.0.0.1:${server.port}`,
      "ACME_KEY",
      (t) => ({ "x-key": t }),
      env,
    );
    try {
      await expect(client.request("GET", "/me")).rejects.toThrow("acme: env var ACME_KEY is not set");
      env.ACME_KEY = "wrong";
      const err = await client.request("GET", "/me", { query: { q: "private" } }).catch((e: Error) => e);
      expect((err as Error).message).toBe("acme GET /me answered 401: denied");
      env.ACME_KEY = "s3cret";
      expect(await client.request<{ ok: boolean }>("GET", "/me")).toEqual({ ok: true });
    } finally {
      server.stop(true);
    }
  });
});
