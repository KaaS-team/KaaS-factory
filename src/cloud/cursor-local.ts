// Drives the Cursor agent binary on this machine inside the issue's worktree, then pushes the branch
// unless policy.push says the agent does. The default argv is unconfirmed against the real binary;
// a repo overrides it with providers.cursor-local.launch.
import { CloudError, type CloudProvider, type CloudRun, type LaunchInput } from "./port";
import type { RunCommand } from "./spawn";

export const CURSOR_LOCAL_ARGV = ["cursor-agent", "--print", "--force", "--model", "{model}"];

export function cursorLocalProvider(opts: { launch: string[]; run: RunCommand; agentPushes?: boolean }): CloudProvider {
  const runs = new Map<string, Promise<CloudRun>>();
  const argvFor = (i: LaunchInput) =>
    (opts.launch.length ? opts.launch : CURSOR_LOCAL_ARGV).map((a) =>
      a.split("{model}").join(i.model).split("{branch}").join(i.branch),
    );

  async function build(id: string, i: LaunchInput): Promise<CloudRun> {
    const built = await opts.run(argvFor(i), { cwd: i.cwd, stdin: i.prompt });
    if (built.code !== 0) return { id, status: "error" };
    if (i.agentPushes) return { id, status: "finished" };
    const pushed = await opts.run(["git", "push", "origin", `HEAD:refs/heads/${i.branch}`], { cwd: i.cwd });
    return { id, status: pushed.code === 0 ? "finished" : "error" };
  }

  return {
    name: "cursor-local",
    async launch(i) {
      if (!i.cwd) throw new CloudError("provider", "cursor-local needs the worktree to run in");
      const id = `local-${i.key}`;
      runs.set(id, build(id, i));
      return { id, status: "running" };
    },
    async poll(id) {
      const pending = runs.get(id);
      if (!pending) throw new CloudError("not_found", "cursor-local has no such run");
      const settled = await Promise.race([pending, Promise.resolve(undefined)]);
      return settled ?? { id, status: "running" };
    },
    async usage() {
      return {};
    },
    async steer() {
      throw new CloudError("provider", "steer is not supported by cursor-local");
    },
    async cancel(id) {
      runs.delete(id);
    },
  };
}
