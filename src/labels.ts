// Single source for every `factory:*` label plus the five issue-form type labels.
// Nothing else in this repo (or the template it installs) should spell a label
// string literally: import from here. tests/labels.test.ts greps for that.

export type LabelCategory = "state" | "parked" | "provenance" | "type";

export interface FactoryLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly category: LabelCategory;
}

// The only place a `factory:*` label string is spelled out. Every other file
// (watch.ts, scan.ts, the dashboard) imports LABEL.* instead of writing the
// string itself — tests/labels.test.ts greps the rest of the tree for that.
export const LABEL = {
  ready: "factory:ready",
  blocked: "factory:blocked",
  triaging: "factory:triaging",
  planning: "factory:planning",
  awaitingApproval: "factory:awaiting-approval",
  building: "factory:building",
  verifying: "factory:verifying",
  inReview: "factory:in-review",
  needsInfo: "factory:needs-info",
  needsHuman: "factory:needs-human",
  failed: "factory:failed",
  monitor: "factory:monitor",
  ledger: "factory:ledger",
} as const;

// One state label at a time: where an issue sits in the lifecycle (plan section 1).
export const STATE_LABELS = [
  LABEL.ready,
  LABEL.blocked,
  LABEL.triaging,
  LABEL.planning,
  LABEL.awaitingApproval,
  LABEL.building,
  LABEL.verifying,
  LABEL.inReview,
] as const;

// Parked: the loop stopped and a human (or a retry) is needed to continue.
export const PARKED_LABELS = [LABEL.needsInfo, LABEL.needsHuman, LABEL.failed] as const;

// Provenance: how the issue was filed.
export const PROVENANCE_LABELS = [LABEL.monitor, LABEL.ledger] as const;

// Type: set by the issue form, read by triage/plan for risk policy. This is
// the default list; a repo may add types via config.routes (e.g. lwp adds
// "content"), so `typesFor` and `issueType` below are what actually decide
// which label on an issue counts as its type, not this array alone.
export const TYPE_LABELS = ["bug", "feature", "docs", "security", "dependency"] as const;

export type StateLabel = (typeof STATE_LABELS)[number];
export type ParkedLabel = (typeof PARKED_LABELS)[number];
export type ProvenanceLabel = (typeof PROVENANCE_LABELS)[number];
export type TypeLabel = (typeof TYPE_LABELS)[number];
export type AnyFactoryLabel = StateLabel | ParkedLabel | ProvenanceLabel;

const STATE_COLOR = "0e8a16"; // green: the loop is actively moving this
const PARKED_COLOR = "d93f0b"; // orange/red: stopped, needs a human
const PROVENANCE_COLOR = "5319e7"; // purple: how it got filed
const TYPE_COLOR: Record<TypeLabel, string> = {
  bug: "d73a4a",
  feature: "a2eeef",
  docs: "0075ca",
  security: "b60205",
  dependency: "fbca04",
};

const STATE_DESCRIPTIONS: Record<StateLabel, string> = {
  "factory:ready": "Human marked this ready for the loop to pick up",
  "factory:blocked": 'Waiting on its "Blocked by" issues to close; promotes to ready automatically',
  "factory:triaging": "factory-triage is classifying this issue",
  "factory:planning": "factory-plan is writing the plan comment",
  "factory:awaiting-approval": "Plan posted, waiting on /factory approve",
  "factory:building": "factory-build is making the change on factory/issue-N",
  "factory:verifying": "proving the change and running factory-reviewer on the diff",
  "factory:in-review": "Draft PR open, waiting on human review and merge",
};

const PARKED_DESCRIPTIONS: Record<ParkedLabel, string> = {
  "factory:needs-info": "Waiting on an answer to a question comment",
  "factory:needs-human": "Refused, or unresolved after two rounds; a human decides",
  "factory:failed": "A stage broke (timeout, red gates, boundary, denied tool); /factory retry resumes",
};

const PROVENANCE_DESCRIPTIONS: Record<ProvenanceLabel, string> = {
  "factory:monitor": "Filed by factory scan from a production signal",
  "factory:ledger": "The factory's spend ledger: one comment per worker per day",
};

const TYPE_DESCRIPTIONS: Record<TypeLabel, string> = {
  bug: "Something behaves incorrectly",
  feature: "A new capability",
  docs: "Documentation only",
  security: "A vulnerability or authorization gap",
  dependency: "A package upgrade or advisory",
};

export const LABELS: readonly FactoryLabel[] = [
  ...STATE_LABELS.map((name) => ({
    name,
    color: STATE_COLOR,
    description: STATE_DESCRIPTIONS[name],
    category: "state" as const,
  })),
  ...PARKED_LABELS.map((name) => ({
    name,
    color: PARKED_COLOR,
    description: PARKED_DESCRIPTIONS[name],
    category: "parked" as const,
  })),
  ...PROVENANCE_LABELS.map((name) => ({
    name,
    color: PROVENANCE_COLOR,
    description: PROVENANCE_DESCRIPTIONS[name],
    category: "provenance" as const,
  })),
  ...TYPE_LABELS.map((name) => ({
    name,
    color: TYPE_COLOR[name],
    description: TYPE_DESCRIPTIONS[name],
    category: "type" as const,
  })),
];

export function findLabel(name: string): FactoryLabel | undefined {
  return LABELS.find((l) => l.name === name);
}

const CUSTOM_STEP_COLOR = "fbca04"; // yellow: a step label from this repo's own workflow
const CUSTOM_TYPE_COLOR = "c5def5"; // light blue: a type this repo added itself, not one of the five defaults

// LABELS plus one entry per repo-added type (a routes key not already in
// TYPE_LABELS), so `factory doctor --fix` creates those labels too.
// `stepLabels` are a workflow's own step labels; one the factory does not
// already ship (a custom check step's `factory:linting`) is created too.
export function labelsFor(
  routes: Readonly<Record<string, unknown>> | undefined,
  stepLabels: readonly string[] = [],
): readonly FactoryLabel[] {
  const extra = Object.keys(routes ?? {})
    .filter((t) => !(TYPE_LABELS as readonly string[]).includes(t))
    .map((name) => ({
      name,
      color: CUSTOM_TYPE_COLOR,
      description: `Type added by this repo's config.routes`,
      category: "type" as const,
    }));
  const steps = [...new Set(stepLabels)]
    .filter((name) => !LABELS.some((l) => l.name === name))
    .map((name) => ({
      name,
      color: CUSTOM_STEP_COLOR,
      description: "A step of this repo's workflow",
      category: "state" as const,
    }));
  return [...LABELS, ...extra, ...steps];
}

// Labels that mark an issue as "in the loop, not yet parked and not done".
// Used by watch.ts to compute the STOP_IF PR count and by the dashboard board columns.
export function isStateLabel(name: string): name is StateLabel {
  return (STATE_LABELS as readonly string[]).includes(name);
}

export function isParkedLabel(name: string): name is ParkedLabel {
  return (PARKED_LABELS as readonly string[]).includes(name);
}

// Strip every factory:* state/parked label from a label list, keeping type and monitor.
export function withoutLifecycleLabels(names: readonly string[]): string[] {
  return names.filter((n) => !isStateLabel(n) && !isParkedLabel(n));
}

// The full type list for a repo: the five defaults plus whatever it declares
// through config.routes (plan v2.7.0 item 1: "the type list comes from config
// everywhere; TYPE_LABELS becomes the default list, not the only one").
export function typesFor(routes: Readonly<Record<string, unknown>> | undefined): string[] {
  return [...new Set<string>([...TYPE_LABELS, ...Object.keys(routes ?? {})])];
}

// The one label on an issue that names its type, or undefined if none of its
// labels is in the repo's type list (routes keys plus TYPE_LABELS).
export function issueType(
  routes: Readonly<Record<string, unknown>> | undefined,
  labelNames: readonly string[],
): string | undefined {
  const types = new Set(typesFor(routes));
  return labelNames.find((n) => types.has(n));
}
