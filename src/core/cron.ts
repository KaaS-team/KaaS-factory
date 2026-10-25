// A five-field cron schedule (minute hour day-of-month month day-of-week) and
// the one question the runner asks of it: does this minute match, in this
// IANA time zone? Numbers, `*`, lists, ranges and `/step` only; no names, no
// `@daily`, no seconds. When both day fields are restricted a day matches
// either, as in Vixie cron. Pure: the clock is passed in.

export class CronError extends Error {}

export interface Cron {
  readonly src: string;
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  readonly domAny: boolean;
  readonly dowAny: boolean;
}

const FIELDS = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day-of-month", 1, 31],
  ["month", 1, 12],
  ["day-of-week", 0, 7],
] as const;

function field(src: string, name: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`${name}: "${part}" is not a number, range, list or step`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    const from = m[1] === "*" ? lo : Number(m[2]);
    const to = m[1] === "*" ? hi : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from;
    if (step < 1) throw new CronError(`${name}: step must be 1 or more`);
    if (from < lo || to > hi || from > to) throw new CronError(`${name}: ${part} is outside ${lo}-${hi}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseCron(src: string): Cron {
  const parts = src.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new CronError(`"${src}" needs 5 fields (minute hour day-of-month month day-of-week), has ${parts.length}`);
  const [minute, hour, dom, month, dowRaw] = FIELDS.map(([name, lo, hi], i) => field(parts[i]!, name, lo, hi));
  // 7 is Sunday too.
  const dow = new Set([...dowRaw!].map((d) => d % 7));
  return {
    src,
    minute: minute!,
    hour: hour!,
    dom: dom!,
    month: month!,
    dow,
    domAny: parts[2] === "*",
    dowAny: parts[4] === "*",
  };
}

// The wall-clock fields of `at` in `tz`, which must be an IANA zone name.
export function wallClock(
  at: Date,
  tz: string,
): { minute: number; hour: number; dom: number; month: number; dow: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
    });
  } catch {
    throw new CronError(`"${tz}" is not an IANA time zone`);
  }
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!);
  return { minute: Number(p.minute), hour: Number(p.hour), dom: Number(p.day), month: Number(p.month), dow };
}

export function cronMatches(cron: Cron, at: Date, tz = "UTC"): boolean {
  const w = wallClock(at, tz);
  if (!cron.minute.has(w.minute) || !cron.hour.has(w.hour) || !cron.month.has(w.month)) return false;
  const domHit = cron.dom.has(w.dom);
  const dowHit = cron.dow.has(w.dow);
  if (cron.domAny || cron.dowAny) return domHit && dowHit;
  return domHit || dowHit;
}
