// A stand-in for agent37's exec API (src/adapters/agent37): check the key,
// run `sh -c command` on this machine, answer {exit_code, stdout, stderr},
// and refuse a body over 128 KB the way the real one does. Tests start it
// on a free loopback port.

export function startAgent37(
  key: string,
  instance: string,
): { url: string; stop: () => void; commands: string[]; keys: Array<string | null> } {
  const commands: string[] = [];
  const keys: Array<string | null> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      keys.push(req.headers.get("x-agent37-key"));
      if (new URL(req.url).pathname !== `/v1/instances/${instance}/exec`) return new Response("no such instance", { status: 404 });
      if (req.headers.get("x-agent37-key") !== key) return new Response("unauthorized", { status: 401 });
      const body = await req.text();
      if (body.length > 128 * 1024) return new Response("The request body must be at most 128 KB.", { status: 413 });
      const { command } = JSON.parse(body) as { command: string };
      commands.push(command);
      const p = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit_code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return Response.json({ exit_code, stdout, stderr, truncated: false });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), commands, keys };
}
