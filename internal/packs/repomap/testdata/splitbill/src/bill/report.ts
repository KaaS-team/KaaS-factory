import { splitEvenly } from "./split";
import { formatCents, sumCents } from "../money/cents";

export function renderReport(total: number, people: number): string {
  return splitEvenly(total, people).map((s) => formatCents(s)).concat(String(sumCents([]))).join("\n");
}
