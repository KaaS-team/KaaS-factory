// The dashboard is its own package. The core starts it through the factory the package exports
// (src/dashboard-host.ts), runs without it, and never imports it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  DASHBOARD_PACKAGE,
  DashboardMissing,
  type DashboardServerOptions,
  loadDashboard,
  serveDashboard,
} from "../src/dashboard-host";
import { copyRepo } from "../scripts/repo-copy";

const ROOT = resolve(import.meta.dir, "..");
const CORE = ["src", "bin"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|js)$/.test(n) || dir.endsWith("bin") ? [p] : [];
  });
}

// Every module specifier a file imports, statically or dynamically.
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1] ?? "");

// A specifier reaches the dashboard when it names the package or a path through the dashboard directory.
export const reachesDashboard = (spec: string): boolean =>
  spec.includes("factory-dashboard") || /(^|\/)dashboard(\/|$)/.test(spec);

export function coreImportsOfDashboard(root = ROOT): string[] {
  return CORE.flatMap((d) => walk(join(root, d))).flatMap((file) =>
    specifiers(readFileSync(file, "utf8"))
      .filter(reachesDashboard)
      .map((s) => `${relative(root, file)} imports ${s}`),
  );
}

const noImporter = async () => {
  throw Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });
};

describe("dashboard package", () => {
  test("it is a workspace package whose entry exports the server factory the core loads", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "dashboard", "package.json"), "utf8"));
    expect(pkg.name).toBe(DASHBOARD_PACKAGE);
    expect(pkg.private).toBe(true);
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).workspaces).toContain("dashboard");
    expect(typeof (await loadDashboard())).toBe("function");
  });

  test("the core hands the options to the factory the package returns, with the host from the environment", async () => {
    const seen: DashboardServerOptions[] = [];
    const importer = async () => ({
      createDashboardServer: (o: DashboardServerOptions) => {
        seen.push(o);
        return o.port;
      },
    });
    const opts = { repo: "a/b", autoApproveDefault: false } as Omit<DashboardServerOptions, "port" | "hostname">;
    expect(await serveDashboard(opts, 4321, { FACTORY_DASHBOARD_HOST: "0.0.0.0" }, importer)).toBe(4321);
    await serveDashboard(opts, 1, {}, importer);
    expect(seen.map((o) => [o.port, o.hostname])).toEqual([
      [4321, "0.0.0.0"],
      [1, "127.0.0.1"],
    ]);
  });

  test("a missing package or a package without the factory is DashboardMissing, other errors pass through", async () => {
    await expect(loadDashboard(noImporter)).rejects.toBeInstanceOf(DashboardMissing);
    await expect(loadDashboard(noImporter)).rejects.toThrow(DASHBOARD_PACKAGE);
    await expect(loadDashboard(async () => ({}))).rejects.toBeInstanceOf(DashboardMissing);
    const boom = async () => {
      throw new Error("syntax error in the dashboard");
    };
    await expect(loadDashboard(boom)).rejects.toThrow("syntax error in the dashboard");
  });

  test("the core runs with no dashboard present, and `dashboard` says what is missing", () => {
    const dir = copyRepo(ROOT, "factory-nodash-");
    try {
      rmSync(join(dir, "dashboard"), { recursive: true });
      const run = (...args: string[]) =>
        Bun.spawnSync(["bun", join(dir, "bin", "factory"), ...args], {
          cwd: dir,
          env: { ...process.env, FACTORY_HOME: join(dir, "home") },
        });
      const help = run("help");
      expect(help.exitCode).toBe(0);
      expect(help.stdout.toString()).toContain("factory");
      const dash = run("dashboard");
      expect(dash.exitCode).not.toBe(0);
      expect(dash.stderr.toString()).toContain(`the dashboard package ${DASHBOARD_PACKAGE} is not installed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the core (src/ and bin/) imports nothing from the dashboard", () => {
    expect(coreImportsOfDashboard()).toEqual([]);
  });

  test("the scan sees an import of the package, of the directory, and a dynamic one", () => {
    const hits = (t: string) => specifiers(t).filter(reachesDashboard);
    expect(hits('import { a } from "../dashboard/server";')).toEqual(["../dashboard/server"]);
    expect(hits('const m = await import("@kaas-team/factory-dashboard");')).toEqual(["@kaas-team/factory-dashboard"]);
    expect(hits('import x from "./dashboard-host";')).toEqual([]);
  });
});
