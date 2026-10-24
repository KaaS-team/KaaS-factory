// `factory daemon install`: run `factory up` for one repo in the background,
// started at login and restarted when it exits. A launchd agent on macOS, a
// systemd user unit on Linux. No secret goes in either file: gh and claude
// read their own credential stores, so the unit carries only PATH and HOME.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DaemonSpec {
  readonly repo: string; // owner/name
  readonly argv: readonly string[]; // the full `factory up ...` command
  readonly workdir: string;
  readonly logDir: string;
  readonly path: string; // PATH, so gh, git and the agents resolve as they do in your shell
  readonly home: string;
}

export type DaemonPlatform = "launchd" | "systemd";

export function daemonPlatform(os: NodeJS.Platform): DaemonPlatform | undefined {
  if (os === "darwin") return "launchd";
  if (os === "linux") return "systemd";
  return undefined;
}

// One daemon per repo, so the name carries the repo.
export function daemonName(repo: string): string {
  return `factory-${repo.replace(/[^A-Za-z0-9]+/g, "-")}`;
}

export function daemonFile(platform: DaemonPlatform, home: string, repo: string): string {
  return platform === "launchd"
    ? join(home, "Library", "LaunchAgents", `com.learnwithparam.${daemonName(repo)}.plist`)
    : join(home, ".config", "systemd", "user", `${daemonName(repo)}.service`);
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(spec: DaemonSpec): string {
  const str = (s: string) => `<string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(`com.learnwithparam.${daemonName(spec.repo)}`)}
  <key>ProgramArguments</key>
  <array>${spec.argv.map((a) => `\n    ${str(a)}`).join("")}
  </array>
  <key>WorkingDirectory</key>${str(spec.workdir)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>${str(spec.path)}
    <key>HOME</key>${str(spec.home)}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key>${str(join(spec.logDir, `${daemonName(spec.repo)}.log`))}
  <key>StandardErrorPath</key>${str(join(spec.logDir, `${daemonName(spec.repo)}.log`))}
</dict>
</plist>
`;
}

// systemd splits ExecStart on spaces and reads C-style escapes inside double
// quotes; `%` is a specifier, so it is doubled.
const unitArg = (s: string): string => `"${unitPath(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
// A path setting (WorkingDirectory, append:) is taken as is, quotes included, so only % is escaped.
const unitPath = (s: string): string => s.replace(/%/g, "%%");

export function systemdUnit(spec: DaemonSpec): string {
  return `[Unit]
Description=software-factory loop for ${spec.repo}
After=network-online.target

[Service]
ExecStart=${spec.argv.map(unitArg).join(" ")}
WorkingDirectory=${unitPath(spec.workdir)}
Environment=${unitArg(`PATH=${spec.path}`)} ${unitArg(`HOME=${spec.home}`)}
Restart=always
RestartSec=30
StandardOutput=append:${unitPath(join(spec.logDir, `${daemonName(spec.repo)}.log`))}
StandardError=append:${unitPath(join(spec.logDir, `${daemonName(spec.repo)}.log`))}

[Install]
WantedBy=default.target
`;
}

export interface DaemonRunner {
  run(argv: readonly string[]): Promise<{ exitCode: number; stderr: string }>;
}

// The commands that start (or stop) the daemon once its file is written.
export function daemonCommands(
  platform: DaemonPlatform,
  file: string,
  uid: number,
  action: "install" | "uninstall",
): string[][] {
  if (platform === "launchd") {
    const domain = `gui/${uid}`;
    // bootout first so a reinstall picks up the new file; it fails harmlessly when nothing is loaded.
    return action === "install"
      ? [
          ["launchctl", "bootout", domain, file],
          ["launchctl", "bootstrap", domain, file],
        ]
      : [["launchctl", "bootout", domain, file]];
  }
  const unit = file.split("/").pop()!;
  return action === "install"
    ? [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", unit],
      ]
    : [["systemctl", "--user", "disable", "--now", unit]];
}

export async function installDaemon(
  platform: DaemonPlatform,
  spec: DaemonSpec,
  uid: number,
  runner: DaemonRunner,
): Promise<string> {
  const file = daemonFile(platform, spec.home, spec.repo);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(spec.logDir, { recursive: true });
  writeFileSync(file, platform === "launchd" ? launchdPlist(spec) : systemdUnit(spec));
  const cmds = daemonCommands(platform, file, uid, "install");
  for (const [i, cmd] of cmds.entries()) {
    const r = await runner.run(cmd);
    const bootout = platform === "launchd" && i === 0;
    if (r.exitCode !== 0 && !bootout) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return file;
}

export async function uninstallDaemon(
  platform: DaemonPlatform,
  home: string,
  repo: string,
  uid: number,
  runner: DaemonRunner,
): Promise<string> {
  const file = daemonFile(platform, home, repo);
  for (const cmd of daemonCommands(platform, file, uid, "uninstall")) await runner.run(cmd); // not loaded is fine
  rmSync(file, { force: true });
  return file;
}
