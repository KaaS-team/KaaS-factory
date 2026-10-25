import { describe, expect, test } from "bun:test";
import { CronError, cronMatches, parseCron } from "../src/core/cron";

const at = (iso: string) => new Date(iso);

describe("parseCron", () => {
  test("expands *, lists, ranges and steps", () => {
    const c = parseCron("*/15 9-17/4 1,15 * 1-5");
    expect([...c.minute]).toEqual([0, 15, 30, 45]);
    expect([...c.hour]).toEqual([9, 13, 17]);
    expect([...c.dom]).toEqual([1, 15]);
    expect(c.month.size).toBe(12);
    expect([...c.dow]).toEqual([1, 2, 3, 4, 5]);
  });

  test("a start with a step runs to the end of the field", () => {
    expect([...parseCron("50/5 * * * *").minute]).toEqual([50, 55]);
  });

  test("7 is Sunday", () => {
    expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
  });

  test.each([
    ["* * * *", /needs 5 fields/],
    ["60 * * * *", /minute: 60 is outside 0-59/],
    ["* 24 * * *", /hour/],
    ["* * 0 * *", /day-of-month/],
    ["* * * 13 *", /month/],
    ["* * * * 8", /day-of-week/],
    ["*/0 * * * *", /step must be 1/],
    ["5-1 * * * *", /outside/],
    ["mon * * * *", /not a number/],
    ["@daily", /needs 5 fields/],
  ])("rejects %s", (src, msg) => {
    expect(() => parseCron(src)).toThrow(CronError);
    expect(() => parseCron(src)).toThrow(msg);
  });
});

describe("cronMatches", () => {
  test("matches the minute it names and not the next", () => {
    const c = parseCron("30 9 * * *");
    expect(cronMatches(c, at("2026-10-09T09:30:00Z"))).toBe(true);
    expect(cronMatches(c, at("2026-10-09T09:30:59Z"))).toBe(true);
    expect(cronMatches(c, at("2026-10-09T09:31:00Z"))).toBe(false);
  });

  test("reads the wall clock in the given IANA zone", () => {
    const c = parseCron("0 9 * * *");
    // 09:00 in Chennai is 03:30 UTC.
    expect(cronMatches(c, at("2026-10-09T03:30:00Z"), "Asia/Kolkata")).toBe(true);
    expect(cronMatches(c, at("2026-10-09T09:00:00Z"), "Asia/Kolkata")).toBe(false);
  });

  test("follows daylight saving: 09:00 New York is 13:00 UTC in summer, 14:00 in winter", () => {
    const c = parseCron("0 9 * * *");
    expect(cronMatches(c, at("2026-07-01T13:00:00Z"), "America/New_York")).toBe(true);
    expect(cronMatches(c, at("2026-12-01T14:00:00Z"), "America/New_York")).toBe(true);
    expect(cronMatches(c, at("2026-12-01T13:00:00Z"), "America/New_York")).toBe(false);
  });

  test("the day of week is the zone's, not UTC's", () => {
    // Friday 23:30 UTC is already Saturday in Tokyo.
    const sat = parseCron("30 8 * * 6");
    expect(cronMatches(sat, at("2026-10-09T23:30:00Z"), "Asia/Tokyo")).toBe(true);
  });

  test("both day fields restricted: either matches (Vixie cron)", () => {
    // The 1st of the month, or any Monday. 2026-10-05 is a Monday, 2026-10-01 a Thursday.
    const c = parseCron("0 0 1 * 1");
    expect(cronMatches(c, at("2026-10-05T00:00:00Z"))).toBe(true);
    expect(cronMatches(c, at("2026-10-01T00:00:00Z"))).toBe(true);
    expect(cronMatches(c, at("2026-10-06T00:00:00Z"))).toBe(false);
  });

  test("one day field restricted: only that one counts", () => {
    const weekdays = parseCron("0 0 * * 1-5");
    expect(cronMatches(weekdays, at("2026-10-10T00:00:00Z"))).toBe(false); // Saturday
    expect(cronMatches(weekdays, at("2026-10-09T00:00:00Z"))).toBe(true); // Friday
  });

  test("an unknown zone is a CronError", () => {
    expect(() => cronMatches(parseCron("* * * * *"), new Date(), "Mars/Olympus")).toThrow(CronError);
  });
});
