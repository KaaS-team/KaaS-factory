import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonCommands,
  daemonFile,
  daemonName,
  daemonPlatform,
  installDaemon,
  launchdPlist,
  systemdUnit,
  uninstallDaemon,
  type DaemonSpec,
} from "../src/daemon";

const spec = (home = "/home/u"): DaemonSpec => ({
  repo: "acme/web&co",
  argv: ["/opt/bun", "/src/cli.ts", "up", "--repo-dir", '/w/a b&c<d>"e"%f'],
  workdir: '/w/a b&c<d>"e"%f',
  logDir: join(home, ".factory", "logs"),
  path: "/opt/bin:/usr/bin",
  home,
});

function fakeRunner(fail: (argv: readonly string[]) => boolean = () => false) {
  const ran: string[] = [];
  return {
    ran,
    run: async (argv: readonly string[]) => (
      ran.push(argv.join(" ")), { exitCode: fail(argv) ? 1 : 0, stderr: "nope" }
    ),
  };
}

describe("daemon", () => {
  test("launchd on macOS, systemd on Linux, nothing elsewhere", () => {
    expect(daemonPlatform("darwin")).toBe("launchd");
    expect(daemonPlatform("linux")).toBe("systemd");
    expect(daemonPlatform("win32")).toBeUndefined();
  });

  test("one daemon per repo, named after it", () => {
    expect(daemonName("acme/web&co")).toBe("factory-acme-web-co");
    expect(daemonFile("launchd", "/h", "acme/web")).toBe(
      "/h/Library/LaunchAgents/com.learnwithparam.factory-acme-web.plist",
    );
    expect(daemonFile("systemd", "/h", "acme/web")).toBe("/h/.config/systemd/user/factory-acme-web.service");
  });

  test("the plist escapes every path, restarts the loop and carries no secret", async () => {
    const plist = launchdPlist(spec());
    expect(plist).toContain('<string>/w/a b&amp;c&lt;d&gt;"e"%f</string>');
    expect(plist).not.toMatch(/&(?!amp;|lt;|gt;)/);
    for (const key of ["<key>RunAtLoad</key><true/>", "<key>KeepAlive</key><true/>"]) expect(plist).toContain(key);
    expect(
      [...plist.matchAll(/<key>(\w+)<\/key><string>/g)].map((m) => m[1]!).filter((k) => k === k.toUpperCase()),
    ).toEqual(["PATH", "HOME"]);
    if (process.platform === "darwin") {
      const dir = mkdtempSync(join(tmpdir(), "plist-"));
      await Bun.write(join(dir, "a.plist"), plist);
      const lint = Bun.spawnSync(["plutil", "-lint", join(dir, "a.plist")]);
      expect(lint.exitCode).toBe(0);
      const args = JSON.parse(
        Bun.spawnSync([
          "plutil",
          "-extract",
          "ProgramArguments",
          "json",
          "-o",
          "-",
          join(dir, "a.plist"),
        ]).stdout.toString(),
      );
      expect(args).toEqual(spec().argv);
    }
  });

  test("the systemd unit quotes each argument, doubles %, and restarts the loop", () => {
    const unit = systemdUnit(spec());
    expect(unit).toContain('ExecStart="/opt/bun" "/src/cli.ts" "up" "--repo-dir" "/w/a b&c<d>\\"e\\"%%f"\n');
    expect(unit).toContain("Restart=always\n");
    // Path settings take the path bare: quotes would become part of it.
    expect(unit).toContain('WorkingDirectory=/w/a b&c<d>"e"%%f\n');
    expect(systemdUnit({ ...spec(), logDir: "/l/50%" })).toContain(
      "StandardOutput=append:/l/50%%/factory-acme-web-co.log\n",
    );
    expect(unit).toContain('Environment="PATH=/opt/bin:/usr/bin" "HOME=/home/u"\n');
    expect(unit).toContain("WantedBy=default.target\n");
  });

  test("install writes the file and loads it; a reinstall replaces what is loaded", async () => {
    const home = mkdtempSync(join(tmpdir(), "daemon-"));
    const runner = fakeRunner((argv) => argv[1] === "bootout");
    const file = await installDaemon("launchd", spec(home), 501, runner);
    expect(readFileSync(file, "utf8")).toBe(launchdPlist(spec(home)));
    expect(runner.ran).toEqual([`launchctl bootout gui/501 ${file}`, `launchctl bootstrap gui/501 ${file}`]);
    expect(existsSync(spec(home).logDir)).toBe(true);
  });

  test("install fails loudly when the service manager refuses it", async () => {
    const home = mkdtempSync(join(tmpdir(), "daemon-"));
    const runner = fakeRunner((argv) => argv.includes("enable"));
    await expect(installDaemon("systemd", spec(home), 1000, runner)).rejects.toThrow(
      "systemctl --user enable --now factory-acme-web-co.service failed: nope",
    );
  });

  test("uninstall stops it and removes the file", async () => {
    const home = mkdtempSync(join(tmpdir(), "daemon-"));
    const runner = fakeRunner();
    const file = await installDaemon("systemd", spec(home), 1000, runner);
    expect(await uninstallDaemon("systemd", home, spec(home).repo, 1000, runner)).toBe(file);
    expect(existsSync(file)).toBe(false);
    expect(runner.ran.at(-1)).toBe("systemctl --user disable --now factory-acme-web-co.service");
    expect(daemonCommands("launchd", file, 1, "uninstall")).toEqual([["launchctl", "bootout", "gui/1", file]]);
  });
});
