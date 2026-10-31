// The wire vocabulary shared by the runner and the dashboard: who may steer, and which commands
// they may send. It imports nothing from src/ or dashboard/, so either side can ship without the other.

export const ROLES = ["viewer", "approver", "operator", "owner"] as const;
export type Role = (typeof ROLES)[number];

export function atLeast(have: Role, need: Role): boolean {
  return ROLES.indexOf(have) >= ROLES.indexOf(need);
}

export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

export type CommandAction = "approve" | "revise" | "answer" | "retry" | "cancel";

// Approving a plan is the one command an approver may send; the rest change what the agent does.
export const COMMANDS: Readonly<Record<string, { action: CommandAction; role: Role }>> = {
  "approve-plan": { action: "approve", role: "approver" },
  revise: { action: "revise", role: "operator" },
  answer: { action: "answer", role: "operator" },
  retry: { action: "retry", role: "operator" },
  cancel: { action: "cancel", role: "operator" },
};
