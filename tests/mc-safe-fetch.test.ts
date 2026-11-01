import { describe, expect, test } from "bun:test";
import { isPrivate, safeFetch, type SafeFetchDeps } from "../src/mc/safe-fetch";

const SECRET = "s3cr3t-token-value";
const policy = { hosts: ["api.vendor.test"], secret: SECRET };

function deps(over: Partial<SafeFetchDeps> = {}, calls: string[] = []): SafeFetchDeps {
  return {
    fetch: async (url) => {
      calls.push(url);
      return new Response("ok", { status: 200 });
    },
    lookup: async () => ["93.184.216.34"],
    ...over,
  };
}

async function refused(url: string, pol = policy, d = deps(), init: RequestInit = {}): Promise<string> {
  try {
    await safeFetch(url, init, pol, d);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("safeFetch refuses before any request", () => {
  const cases: [string, string, typeof policy | Record<string, unknown>][] = [
    ["http scheme", "http://api.vendor.test/x", policy],
    ["host off the list", "https://evil.test/x", policy],
    ["userinfo", "https://u:p@api.vendor.test/x", policy],
    ["secret in the URL", `https://api.vendor.test/x?q=${SECRET}`, policy],
    ["loopback http without allowPrivate", "http://localhost/x", { hosts: ["localhost"] }],
  ];
  for (const [name, url, pol] of cases) {
    test(name, async () => {
      const calls: string[] = [];
      await refused(url, pol as typeof policy, deps({}, calls));
      expect(calls).toEqual([]);
    });
  }

  test("a host resolving to a private address", async () => {
    const calls: string[] = [];
    const msg = await refused("https://api.vendor.test/x", policy, deps({ lookup: async () => ["10.0.0.5"] }, calls));
    expect(msg).toContain("private");
    expect(calls).toEqual([]);
  });

  test("any private answer among several is refused", async () => {
    const d = deps({ lookup: async () => ["93.184.216.34", "169.254.169.254"] });
    await refused("https://api.vendor.test/x", policy, d);
  });
});

describe("isPrivate", () => {
  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.0.1",
    "::1",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
  ])
    test(`${a} is private`, () => expect(isPrivate(a)).toBe(true));
  for (const a of ["93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:2800:220:1:248:1893:25c8:1946"])
    test(`${a} is public`, () => expect(isPrivate(a)).toBe(false));
});

describe("safeFetch sends", () => {
  test("a good call goes out with redirect manual and returns the body", async () => {
    let init: RequestInit | undefined;
    const d = deps({
      fetch: async (_u, i) => {
        init = i;
        return new Response("hello");
      },
    });
    const res = await safeFetch("https://api.vendor.test/x", { method: "GET" }, policy, d);
    expect(await res.text()).toBe("hello");
    expect(init?.redirect).toBe("manual");
  });

  test("a 302 is an error", async () => {
    const d = deps({
      fetch: async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }),
    });
    expect(await refused("https://api.vendor.test/x", policy, d)).toContain("redirect");
  });

  test("a body over the cap is an error", async () => {
    const d = deps({ fetch: async () => new Response("x".repeat(100)) });
    expect(await refused("https://api.vendor.test/x", { ...policy, maxBytes: 10 } as typeof policy, d)).toContain(
      "over 10",
    );
  });

  test("a call that hangs is aborted at timeoutMs", async () => {
    const d = deps({ fetch: () => new Promise<Response>(() => {}) });
    const msg = await refused("https://api.vendor.test/x", { ...policy, timeoutMs: 20 } as typeof policy, d);
    expect(msg).toContain("timed out");
  });

  test("allowPrivate lets loopback http through", async () => {
    const d = deps({ lookup: async () => ["127.0.0.1"] });
    const res = await safeFetch("http://localhost:8080/x", {}, { hosts: ["localhost"], allowPrivate: true }, d);
    expect(res.status).toBe(200);
  });

  test("an error from fetch never carries the secret", async () => {
    const d = deps({
      fetch: async () => {
        throw new Error(`connect failed for key=${SECRET} and ${SECRET}`);
      },
    });
    const msg = await refused("https://api.vendor.test/x", policy, d);
    expect(msg).not.toContain(SECRET);
  });

  test("a refusal for a URL holding the secret never carries it", async () => {
    const msg = await refused(`https://api.vendor.test/x?q=${SECRET}`);
    expect(msg).not.toContain(SECRET);
  });
});
