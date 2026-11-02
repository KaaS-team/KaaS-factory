// The declared list of setting keys. Nothing reads it yet; a later change adds get/set/explain on top.
import type { Level } from "../team/resolve";

export const CAPABILITIES = ["checks", "preview", "review", "qa", "summary", "notifications"] as const;
export const MODES = ["off", "byo", "ours"] as const;

export interface SettingKey {
  key: string;
  type: string;
  kind: "preference" | "policy";
  levels: readonly Level[];
  storage: "file" | "runtime";
  visible: "customer" | "operator";
  ceiling?: string;
  doc: string;
}

const FILE_LEVELS: readonly Level[] = ["builtin", "org", "team", "repo"];

export const SETTINGS: readonly SettingKey[] = [
  ...CAPABILITIES.flatMap((c): SettingKey[] => [
    {
      key: `capabilities.${c}.mode`,
      type: "enum",
      kind: "preference",
      levels: FILE_LEVELS,
      storage: "file",
      visible: "customer",
      ceiling: `policy.capabilities.${c}.allow`,
      doc: `Whether the ${c} capability is off, brought by the team, or provided by the factory.`,
    },
    {
      key: `capabilities.${c}.provider`,
      type: "string",
      kind: "preference",
      levels: FILE_LEVELS,
      storage: "file",
      visible: "customer",
      doc: `Which provider serves the ${c} capability.`,
    },
  ]),
  ...CAPABILITIES.map(
    (c): SettingKey => ({
      key: `policy.capabilities.${c}.allow`,
      type: "enum-list",
      kind: "policy",
      levels: FILE_LEVELS,
      storage: "file",
      visible: "customer",
      doc: `The modes the ${c} capability may be set to.`,
    }),
  ),
  {
    key: "toggles.auto_start",
    type: "boolean",
    kind: "preference",
    levels: [],
    storage: "runtime",
    visible: "operator",
    doc: "Written by POST /api/toggles; whether queued work starts on its own.",
  },
  {
    key: "toggles.auto_approve_low_risk",
    type: "boolean",
    kind: "preference",
    levels: [],
    storage: "runtime",
    visible: "operator",
    doc: "Written by POST /api/toggles; whether low-risk plans are approved without a human.",
  },
];

export function settingByKey(key: string): SettingKey | undefined {
  return SETTINGS.find((s) => s.key === key);
}

export function checkValue(key: string, value: unknown): string[] {
  const s = settingByKey(key);
  if (!s) return [`${key} is not a known setting.`];
  if (s.type === "enum") {
    if (!(MODES as readonly unknown[]).includes(value)) return [`${key} must be one of ${MODES.join(", ")}.`];
  } else if (s.type === "boolean") {
    if (typeof value !== "boolean") return [`${key} must be true or false.`];
  } else if (s.type === "string") {
    if (typeof value !== "string") return [`${key} must be a string.`];
  } else if (s.type === "enum-list") {
    if (!Array.isArray(value) || !value.every((v) => (MODES as readonly unknown[]).includes(v)))
      return [`${key} must be a list of ${MODES.join(", ")}.`];
  }
  return [];
}

export function registryProblems(list: readonly SettingKey[] = SETTINGS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    if (seen.has(s.key)) out.push(`${s.key} is declared twice.`);
    seen.add(s.key);
  }
  for (const s of list) {
    if (s.ceiling !== undefined && !list.some((p) => p.key === s.ceiling && p.kind === "policy"))
      out.push(`${s.key} has a ceiling, ${s.ceiling}, that is not a policy key.`);
  }
  for (const c of CAPABILITIES) {
    if (!seen.has(`capabilities.${c}.mode`)) out.push(`capability ${c} has no mode key.`);
  }
  return out;
}
