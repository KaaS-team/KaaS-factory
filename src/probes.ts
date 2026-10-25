// `which` and `<bin> --version`, shared by `factory doctor` and the dashboard's Agents page.

export async function which(bin: string): Promise<boolean> {
  const proc = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "pipe" });
  return (await proc.exited) === 0;
}

export async function versionOf(bin: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
    // A CLI that hangs on --version (an update prompt, a login wall) must not hang the caller.
    const timer = setTimeout(() => proc.kill(), 5000);
    try {
      const out = await new Response(proc.stdout).text();
      return (await proc.exited) === 0 ? out.trim() : undefined;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}
