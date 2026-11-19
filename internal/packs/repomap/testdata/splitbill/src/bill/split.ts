import { formatCents, parseCents } from "../money/cents";

export function splitEvenly(total: number, people: number): number[] {
  const cents = parseCents(String(total));
  return Array.from({ length: people }, () => formatCents(Math.floor(cents / people)));
}

export function splitWeighted(total: number, weights: number[]): number[] {
  return weights.map((w) => formatCents(parseCents(String(total)) * w));
}
