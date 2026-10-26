// SPDX-License-Identifier: LicenseRef-KaaS-EE
import { expect, test } from "bun:test";
import { auditExportExtension } from "../plane/audit-export";
import { cookieFor, plane } from "./plane";

const get = (p: ReturnType<typeof plane>, query: string, cookie: string) =>
  p.handle(new Request(`http://localhost:4100/api/audit/export${query}`, { headers: { cookie } }));

test("an owner exports every audit row, oldest first, as JSON lines or CSV, and resumes after an id", async () => {
  const p = plane([auditExportExtension()]);
  p.store.setMember("boss", "owner", "test");
  p.store.setMember("eve", "operator", "test");
  // More rows than one page, so the export must keep reading past the first.
  for (let i = 1; i <= 450; i++)
    p.store.record({ actor: i === 7 ? "=HYPERLINK(1)" : "boss", role: "owner", route: "POST /api/tasks", issue: i, status: 200 });
  const owner = cookieFor(p, "boss");

  const lines = (await (await get(p, "", owner)).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.length).toBe(450);
  expect(lines.map((r) => r.issue)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));

  const resumed = (await (await get(p, `?after=${lines[399].id}`, owner)).text()).trim().split("\n");
  expect(resumed.map((l) => JSON.parse(l).issue)).toEqual(Array.from({ length: 50 }, (_, i) => i + 401));

  const csv = await get(p, "?format=csv", owner);
  expect(csv.headers.get("content-type")).toContain("text/csv");
  const rows = (await csv.text()).trim().split("\n");
  expect(rows[0]).toBe("id,at,actor,role,route,issue,status");
  expect(rows.length).toBe(451);
  expect(rows[7]).toContain(`"'=HYPERLINK(1)"`);

  expect((await get(p, "", cookieFor(p, "eve"))).status).toBe(403);
});
