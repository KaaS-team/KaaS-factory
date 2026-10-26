// SPDX-License-Identifier: LicenseRef-KaaS-EE
// The whole audit log, oldest first, as JSON lines or CSV, streamed page by page so a long log never
// sits in memory. `after` resumes from the last id a previous export saw, before the log rolls.
import type { AuditRow, PlaneStore } from "../../dashboard/plane/store";
import type { PlaneExtension } from "../../dashboard/plane/extension";

const COLUMNS = ["id", "at", "actor", "role", "route", "issue", "status"] as const;

// A spreadsheet runs a cell that starts with = + - @, so such a value is quoted as text.
const cell = (v: unknown) => {
  const s = v === null ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r']/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function exportAudit(store: PlaneStore, after: number, format: "jsonl" | "csv"): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let cursor = after;
  let header = format === "csv";
  return new ReadableStream({
    pull(controller) {
      if (header) {
        header = false;
        controller.enqueue(enc.encode(`${COLUMNS.join(",")}\n`));
      }
      const rows: AuditRow[] = store.auditAfter(cursor);
      if (rows.length === 0) return controller.close();
      cursor = rows[rows.length - 1]!.id;
      const text = rows
        .map((r) => (format === "csv" ? COLUMNS.map((c) => cell(r[c])).join(",") : JSON.stringify(r)))
        .join("\n");
      controller.enqueue(enc.encode(`${text}\n`));
    },
  });
}

export function auditExportExtension(): PlaneExtension {
  return {
    name: "audit-export",
    routes: (ctx) => [
      {
        method: "GET",
        pattern: /^\/api\/audit\/export$/,
        label: "GET /api/audit/export",
        role: "owner",
        handler: (_req, url) => {
          const format = url.searchParams.get("format") === "csv" ? "csv" : "jsonl";
          const after = Number(url.searchParams.get("after") ?? 0);
          const type = format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson";
          return new Response(exportAudit(ctx.store, Number.isInteger(after) && after > 0 ? after : 0, format), {
            headers: { "content-type": type, "content-disposition": `attachment; filename="factory-audit.${format}"` },
          });
        },
      },
    ],
  };
}
