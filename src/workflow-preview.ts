// `factory workflow run <name> --preview`: the stages run, and every write to the tracker or the code
// host is recorded instead of made. The code host is never called at all, reads included.

import type { EventBus } from "./engine/bus";
import type { Git } from "./git";
import type { ScmPort } from "./ports/scm";
import type { WatchDeps } from "./engine/common";
import { FactoryState } from "./state";

export interface PreviewWrite {
  readonly op: string;
  readonly target: string;
  readonly body?: string;
}

// Method name -> [index of the issue/PR number or id, index of the body], per write.
const TRACKER_WRITES: Record<string, { target: (a: unknown[]) => string; body?: (a: unknown[]) => unknown }> = {
  commentIssue: { target: (a) => `issue #${a[1]}`, body: (a) => a[2] },
  editComment: { target: (a) => `comment ${a[1]}`, body: (a) => a[2] },
  addLabels: { target: (a) => `issue #${a[1]}`, body: (a) => `add labels: ${(a[2] as string[]).join(", ")}` },
  removeLabels: { target: (a) => `issue #${a[1]}`, body: (a) => `remove labels: ${(a[2] as string[]).join(", ")}` },
  setStateLabel: { target: (a) => `issue #${a[1]}`, body: (a) => `label ${a[3]}` },
  closeIssue: { target: (a) => `issue #${a[1]}` },
  reopenIssue: { target: (a) => `issue #${a[1]}` },
  editIssueBody: { target: (a) => `issue #${a[1]}`, body: (a) => a[2] },
  createIssue: { target: () => "new issue", body: (a) => `${a[1]}\n\n${a[2]}` },
  ensureLabel: { target: (a) => `label ${a[1]}` },
};

const CODE_HOST_WRITES: Record<string, { target: (a: unknown[]) => string; body?: (a: unknown[]) => unknown }> = {
  createPr: {
    target: (a) => `pull request ${(a[0] as { head?: string }).head ?? ""}`,
    body: (a) => `${(a[0] as { title?: string }).title ?? ""}\n\n${(a[0] as { body?: string }).body ?? ""}`,
  },
  markReady: { target: (a) => `pull request ${a[1]}`, body: (a) => `ready: ${a[2]}` },
  closePr: { target: (a) => `pull request #${a[1]}` },
  mergePr: { target: (a) => `pull request #${a[1]}` },
};

// What a code host read answers in a preview: nothing exists there yet.
const CODE_HOST_READS: Record<string, () => unknown> = {
  listPrs: () => [],
  findPrByHead: () => undefined,
  mergedPrByHead: () => undefined,
  prFeedback: () => [],
  prForIssue: () => undefined,
  authStatus: () => ({ ok: true, detail: "preview" }),
};
const CODE_HOST_ONLY = new Set(["getPr", "prStatus", "mergeReadiness", "prDiff", "prFiles", "fileAtRef", "rateLimit"]);

export function previewScm(real: ScmPort, writes: PreviewWrite[]): ScmPort {
  const record = (op: string, spec: (typeof TRACKER_WRITES)[string], args: unknown[]) => {
    const body = spec.body?.(args);
    writes.push({ op, target: spec.target(args), ...(body === undefined ? {} : { body: String(body) }) });
  };
  return new Proxy(real, {
    get(target, prop, receiver) {
      const name = String(prop);
      if (name in CODE_HOST_WRITES)
        return async (...args: unknown[]) => {
          record(name, CODE_HOST_WRITES[name]!, args);
          return name === "createPr" ? "(preview: no pull request opened)" : undefined;
        };
      if (name in CODE_HOST_READS) return async () => CODE_HOST_READS[name]!();
      if (CODE_HOST_ONLY.has(name))
        // Optional reads stay absent so callers take their no-capability path; the rest cannot be answered.
        return name === "prFiles" || name === "fileAtRef" || name === "rateLimit"
          ? undefined
          : async () => {
              throw new Error(`preview: ${name} would read the code host, which a preview never calls`);
            };
      if (name in TRACKER_WRITES)
        return async (...args: unknown[]) => {
          record(name, TRACKER_WRITES[name]!, args);
          return name === "commentIssue" || name === "createIssue" ? 0 : undefined;
        };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function previewGit(real: Git, writes: PreviewWrite[]): Git {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "claim")
        return async (_dir: string, issue: number) => {
          writes.push({ op: "claim", target: `branch ${real.branchName(issue)}` });
          return true;
        };
      if (prop === "push" || prop === "pushBranch")
        return async (_dir: string, ref: number | string) => {
          writes.push({ op: "push", target: `branch ${typeof ref === "number" ? real.branchName(ref) : ref}` });
          return { stdout: "", stderr: "", code: 0 };
        };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Events still reach the real log, each marked `preview: true`, so nothing reading it counts the run.
export function markPreview(bus: EventBus | undefined): EventBus | undefined {
  if (!bus) return undefined;
  return new Proxy(bus, {
    get(target, prop, receiver) {
      if (prop === "emit")
        return (type: Parameters<EventBus["emit"]>[0], data: unknown, subject?: string) =>
          target.emit(type, { ...(data as object), preview: true }, subject);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Run rows, leases, spend comments and blobs are all writes to something shared, so a preview
// gets a scratch store and none of the others.
export function previewDeps(deps: WatchDeps, writes: PreviewWrite[]): WatchDeps {
  const { leases: _l, spend: _s, blobs: _b, bus, ...rest } = deps;
  const marked = markPreview(bus);
  return {
    ...rest,
    github: previewScm(deps.github, writes),
    git: previewGit(deps.git, writes),
    state: new FactoryState(":memory:"),
    routeWorkflows: {},
    ...(marked ? { bus: marked } : {}),
  };
}
