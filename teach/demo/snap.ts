// Renders every pane of one tmux window, colours included, as one HTML page
// laid out like the terminal, so a headless browser can screenshot it for a deck.
// Usage: bun teach/demo/snap.ts <session>:<window> <out.png>  (the page is kept beside it as .html)

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

export interface Pane { left: number; top: number; width: number; height: number; text: string }

const BASE = ["#1e1e1e", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"];
const BRIGHT = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];

function cube(n: number): string {
  if (n < 8) return BASE[n] as string;
  if (n < 16) return BRIGHT[n - 8] as string;
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16, f = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${f(Math.floor(i / 36))},${f(Math.floor(i / 6) % 6)},${f(i % 6)})`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// SGR only (colour, bold, reset); capture-pane -e emits nothing else.
export function ansiToHtml(text: string): string {
  let fg: string | undefined, bg: string | undefined, bold = false, out = "";
  const parts = text.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const chunk = parts[i] as string;
      if (!chunk) continue;
      const style = [fg && `color:${fg}`, bg && `background:${bg}`, bold && "font-weight:bold"].filter(Boolean).join(";");
      out += style ? `<span style="${style}">${esc(chunk)}</span>` : esc(chunk);
      continue;
    }
    const codes = (parts[i] || "0").split(";").map(Number);
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j] as number;
      if (c === 0) { fg = bg = undefined; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c >= 30 && c <= 37) fg = BASE[c - 30];
      else if (c >= 90 && c <= 97) fg = BRIGHT[c - 90];
      else if (c >= 40 && c <= 47) bg = BASE[c - 40];
      else if (c === 39) fg = undefined;
      else if (c === 49) bg = undefined;
      else if ((c === 38 || c === 48) && codes[j + 1] === 5) { const v = cube(codes[j + 2] as number); if (c === 38) fg = v; else bg = v; j += 2; }
      else if ((c === 38 || c === 48) && codes[j + 1] === 2) { const v = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`; if (c === 38) fg = v; else bg = v; j += 4; }
    }
  }
  return out;
}

export function renderPage(title: string, panes: readonly Pane[]): string {
  const cols = Math.max(...panes.map((p) => p.left + p.width));
  const rows = Math.max(...panes.map((p) => p.top + p.height));
  const body = panes
    .map((p) => `<pre style="left:${p.left}ch;top:calc(${p.top} * var(--lh));width:${p.width}ch;height:calc(${p.height} * var(--lh))">${ansiToHtml(p.text)}</pre>`)
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>
:root{--lh:1.25em}
body{margin:0;background:#1e1e1e;display:flex;align-items:center;justify-content:center;height:100vh}
#t{position:relative;width:${cols}ch;height:calc(${rows} * var(--lh));font:15px/1.25 "JetBrains Mono",Menlo,monospace;color:#e5e5e5}
pre{position:absolute;margin:0;overflow:hidden;font:inherit;outline:1px solid #444}
</style>
<div id="t">${body}</div>`;
}

async function tmux(args: string[]): Promise<string> {
  const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`tmux ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out;
}

async function cli(args: string[]): Promise<void> {
  // It writes page snapshots into its cwd, so that is a temp dir, never the repo.
  const p = Bun.spawn(["playwright-cli", "-s=factory-snap", ...args], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0 || out.includes("### Error")) throw new Error(`playwright-cli ${args[0]}: ${out}`);
}

// playwright-cli blocks file: URLs, so the page is served on loopback for the one screenshot.
async function screenshot(html: string, png: string): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) });
  try {
    await cli(["open", server.url.href]);
    await cli(["resize", "1920", "1080"]);
    await cli(["screenshot", "--filename", png]);
  } finally {
    await cli(["close"]).catch(() => {});
    server.stop(true);
  }
}

if (import.meta.main) {
  const [target, out] = Bun.argv.slice(2);
  if (!target || !out?.endsWith(".png")) { console.error("usage: bun teach/demo/snap.ts <session>:<window> <out.png>"); process.exit(2); }
  const rows = (await tmux(["list-panes", "-t", target, "-F", "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"])).trim().split("\n");
  const panes: Pane[] = [];
  for (const row of rows) {
    const [id, left, top, width, height] = row.split(" ");
    panes.push({ left: Number(left), top: Number(top), width: Number(width), height: Number(height), text: await tmux(["capture-pane", "-e", "-p", "-t", id as string]) });
  }
  const html = renderPage(target, panes);
  writeFileSync(out.replace(/\.png$/, ".html"), html);
  await screenshot(html, out);
}
