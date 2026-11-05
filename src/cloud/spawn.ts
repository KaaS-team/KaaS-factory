// The one place a cloud command is spawned; providers take it as `run` so tests pass a fake.
export type RunCommand = (
  argv: string[],
  opts?: { cwd?: string; stdin?: string },
) => Promise<{ code: number; stdout: string }>;

export const spawnRun: RunCommand = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts?.cwd,
    stdin: opts?.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
};
