import { expect, test } from "bun:test";
import { previewEnv, parsePreviewReply, shouldCreatePreview } from "../src/preview/contract";

const HEAD = "abc123";
const reply = (extra: Record<string, unknown>) => ({ id: "p1", state: "ready", sha: HEAD, ...extra });
const create = (o: Partial<Parameters<typeof shouldCreatePreview>[0]>) =>
  shouldCreatePreview({ paths: ["web/a.tsx"], when: "always", fork: false, forks: "never", approved: false, ...o });

test("a https reply with the matching sha is ready and another sha is stale", () => {
  const url = `${"https"}://p.example.com/x`;
  const ok = parsePreviewReply(reply({ url }), { head: HEAD });
  expect(ok.ok && ok.reply.state).toBe("ready");
  const other = parsePreviewReply(reply({ url, sha: "def456" }), { head: HEAD });
  expect(other.ok && other.reply.state).toBe("stale");
});

test("a plain http or javascript url is rejected and loopback http is accepted", () => {
  expect(parsePreviewReply(reply({ url: "http://example.com/x" }), { head: HEAD }).ok).toBe(false);
  expect(parsePreviewReply(reply({ url: "javascript:alert(1)" }), { head: HEAD }).ok).toBe(false);
  expect(parsePreviewReply(reply({ logUrl: "ftp://example.com/log" }), { head: HEAD }).ok).toBe(false);
  expect(parsePreviewReply(reply({ url: "http://127.0.0.1:3000" }), { head: HEAD }).ok).toBe(true);
});

test("a fork pull request is refused unless forks are approved and approved", () => {
  expect(create({ fork: true, forks: "never", approved: true })).toBe(false);
  expect(create({ fork: true, forks: "approved", approved: false })).toBe(false);
  expect(create({ fork: true, forks: "approved", approved: true })).toBe(true);
  expect(create({ fork: false })).toBe(true);
});

test("a change touching only a server file is not a ui change", () => {
  expect(create({ paths: ["src/server.ts"], when: "ui" })).toBe(false);
  expect(create({ paths: ["src/server.ts"], when: "always" })).toBe(true);
});

test("previewEnv is empty unless the reply is ready", () => {
  const url = "http://localhost:3000";
  const stale = parsePreviewReply(reply({ url, sha: "zzz" }), { head: HEAD });
  expect(stale.ok && previewEnv(stale.reply)).toEqual({});
  const ready = parsePreviewReply(reply({ url }), { head: HEAD });
  expect(ready.ok && previewEnv(ready.reply)).toEqual({ FACTORY_PREVIEW_URL: url });
});

test("a model id in the message is redacted", () => {
  const r = parsePreviewReply(reply({ message: "built by claude-opus-5-5 ok" }), { head: HEAD });
  expect(r.ok && r.reply.message).toBe("built by [removed] ok");
});
