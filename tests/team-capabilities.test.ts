// Capabilities through resolveTeam (the call site), plus resolveCapabilities for the list cases.
import { describe, expect, test } from "bun:test";
import { resolveCapabilities } from "../src/team/capabilities";
import { resolveTeam } from "../src/team/resolve";

const builtin = { model: "sonnet" };
const orgFile = (policy: unknown) => ({ name: "o", policy }) as never;
const teamFile = (capabilities: unknown) => ({ name: "web", capabilities }) as never;
const get = (v: unknown, path: string) =>
  path.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], v);

describe("team capabilities", () => {
  test("a mode the org does not allow is a problem and the allowed value stays", () => {
    const r = resolveTeam({
      builtin,
      org: orgFile({ capabilities: { review: { allow: ["ours", "byo"] } } }),
      team: teamFile({ review: { mode: "off" } }),
    });
    expect(r.problems).toEqual(["capabilities.review.mode is off in team web, but the org allows only ours or byo."]);
    const c = resolveCapabilities({
      org: { policy: { capabilities: { review: { allow: ["ours", "byo"] } } } },
      team: { capabilities: { review: { mode: "off" } } },
      teamName: "web",
    });
    expect(c.values.review?.mode).toBe("ours");
  });

  test("required at the org resolves true and a team cannot set it false", () => {
    const r = resolveTeam({
      builtin,
      org: orgFile({ capabilities: { qa: { required: true } } }),
      team: teamFile({ qa: { required: false } }),
    });
    expect(get(r.values, "capabilities.qa.required")).toBe(true);
    expect(r.origin["capabilities.qa.required"]).toBe("org");
    expect(r.problems).toEqual([]);
  });

  test("a provider outside the org list is a problem and one inside is accepted", () => {
    const org = orgFile({ capabilities: { checks: { providers: ["acme"] } } });
    const bad = resolveTeam({ builtin, org, team: teamFile({ checks: { provider: "other" } }) });
    expect(bad.problems).toEqual(["capabilities.checks.provider is other in team web, but the org allows only acme."]);
    const ok = resolveTeam({ builtin, org, team: teamFile({ checks: { provider: "acme" } }) });
    expect(ok.problems).toEqual([]);
    expect(get(ok.values, "capabilities.checks.provider")).toBe("acme");
  });

  test("allow lists intersect across levels", () => {
    const c = resolveCapabilities({
      org: { policy: { capabilities: { review: { allow: ["ours", "byo"] } } } },
      team: {
        policy: { capabilities: { review: { allow: ["byo", "off"] } } },
        capabilities: { review: { mode: "ours" } },
      },
      teamName: "web",
    });
    expect(c.problems).toEqual(["capabilities.review.mode is ours in team web, but team web allows only byo or off."]);
    expect(c.values.review?.mode).toBe("byo");
  });

  test("required with mode off, an unknown mode and an unknown capability are problems", () => {
    const c = resolveCapabilities({
      org: { policy: { capabilities: { review: { required: true } } } },
      team: { capabilities: { review: { mode: "off" }, qa: { mode: "maybe" }, bogus: { mode: "ours" } } },
      teamName: "web",
    });
    expect(c.problems).toEqual([
      "capabilities.bogus is set in team web, but bogus is not a known capability.",
      "capabilities.review.mode is off in team web, but the org requires review.",
      "capabilities.qa.mode is maybe in team web, but it must be one of off or byo or ours.",
    ]);
  });

  test("the most local mode wins and a file without capabilities resolves as before", () => {
    const r = resolveTeam({
      builtin,
      org: { name: "o", capabilities: { summary: { mode: "byo" } } } as never,
      team: teamFile({ summary: { mode: "off" } }),
      repo: { capabilities: { summary: { mode: "ours" } } },
    });
    expect(get(r.values, "capabilities.summary.mode")).toBe("ours");
    expect(r.origin["capabilities.summary.mode"]).toBe("repo");
    const plain = resolveTeam({ builtin, org: { name: "o" }, team: { name: "t" } });
    expect(plain.values).toEqual(builtin);
    expect(plain.problems).toEqual([]);
  });
});
