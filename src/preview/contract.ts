import { stripOperatorDetail } from "../comment-voice";
import { isUiChange } from "../visual";

export const PREVIEW_KINDS = ["deployments", "template", "http", "exec"] as const;
export const PREVIEW_STATES = ["pending", "building", "ready", "failed", "stopped", "stale"] as const;
export const PREVIEW_VAR = /^FACTORY_PREVIEW_\w+$/;

export type PreviewState = (typeof PREVIEW_STATES)[number];
export type PreviewReply = {
  id: string;
  state: PreviewState;
  url?: string;
  sha?: string;
  logUrl?: string;
  message?: string;
};
export type PreviewParse = { ok: true; reply: PreviewReply } | { ok: false; reason: string };

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

// Absolute https, or http to loopback only.
function safeUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.includes(u.hostname));
}

function optionalString(o: Record<string, unknown>, key: string): string | undefined | null {
  const v = o[key];
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : null;
}

export function parsePreviewReply(raw: unknown, want: { head: string }): PreviewParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, reason: "reply is not an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id === "") return { ok: false, reason: "id is missing" };
  const given = o.state;
  if (typeof given !== "string" || !(PREVIEW_STATES as readonly string[]).includes(given)) {
    return { ok: false, reason: "state is not known" };
  }
  const fields: Record<string, string | undefined> = {};
  for (const key of ["url", "sha", "logUrl", "message"]) {
    const v = optionalString(o, key);
    if (v === null) return { ok: false, reason: `${key} is not a string` };
    fields[key] = v;
  }
  for (const key of ["url", "logUrl"]) {
    const v = fields[key];
    if (v !== undefined && !safeUrl(v)) return { ok: false, reason: `${key} is not an absolute https url` };
  }
  const { url, sha, logUrl, message } = fields;
  const state = given === "ready" && sha !== want.head ? "stale" : given;
  const reply: PreviewReply = { id: o.id, state: state as PreviewState };
  if (url !== undefined) reply.url = url;
  if (sha !== undefined) reply.sha = sha;
  if (logUrl !== undefined) reply.logUrl = logUrl;
  if (message !== undefined) reply.message = stripOperatorDetail(message);
  return { ok: true, reply };
}

export function shouldCreatePreview(o: {
  paths: readonly string[];
  when: "ui" | "always";
  fork: boolean;
  forks: "never" | "approved";
  approved: boolean;
}): boolean {
  if (o.fork && !(o.forks === "approved" && o.approved)) return false;
  return o.when === "always" || isUiChange(o.paths);
}

export function previewEnv(reply: PreviewReply): Record<string, string> {
  return reply.state === "ready" && reply.url !== undefined ? { FACTORY_PREVIEW_URL: reply.url } : {};
}
