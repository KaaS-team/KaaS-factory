// SPDX-License-Identifier: LicenseRef-KaaS-EE
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planeExtensions } from "../../dashboard/plane/extension";
import { loadPlugin } from "../../src/plugins/loader";

const dir = join(import.meta.dir, "..");

test("ee/ is a package whose manifest the plugin loader accepts and runs", async () => {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  expect(pkg.name).toBe("@kaas-team/factory-enterprise");
  expect(pkg.license).toBe("LicenseRef-KaaS-EE");
  const manifest = await loadPlugin(dir, "enterprise");
  expect(manifest).toEqual({ name: "enterprise", kind: "extension", entry: "plugin.ts" });
  // SSO, roles and audit export register without any setting.
  const names = planeExtensions().map((e) => e.name);
  for (const n of ["sso", "roles", "audit-export"]) expect(names).toContain(n);
});
