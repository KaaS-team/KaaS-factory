// Plane audit rows as CloudEvents. The row goes out through the event bus, so the
// sinks, the HMAC signature and the retry queue are the ones every other event uses.

import { emitEvent, type EventBus } from "./engine/bus";

// The fields of dashboard/plane/store.ts AuditRow that leave the plane; src/ never imports dashboard/.
export interface AuditEventRow {
  readonly at: string;
  readonly actor: string;
  readonly role: string;
  readonly route: string;
  readonly issue: number | null;
  readonly status: number;
}

export function auditEventData(row: AuditEventRow) {
  return {
    at: row.at,
    actor: row.actor,
    role: row.role,
    route: row.route,
    issue: row.issue,
    status: row.status,
    outcome: row.status >= 200 && row.status < 400 ? "success" : row.status === 403 ? "refused" : "failure",
  };
}

// The CloudEvents subject is the route, so a SIEM can filter on it without parsing data.
export function emitAudit(bus: EventBus | undefined, row: AuditEventRow): void {
  emitEvent(bus, "factory.audit.recorded", auditEventData(row), row.route);
}
