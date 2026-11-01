import { describe, expect, test } from "bun:test";
import { capOutput } from "../src/output-cap";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i).padStart(3, "0")}`).join("\n");
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("capOutput", () => {
  test("text under the cap is returned unchanged", () => {
    const t = lines(5);
    expect(capOutput(t, 1000)).toEqual({ text: t, droppedBytes: 0 });
    expect(capOutput(t, bytes(t))).toEqual({ text: t, droppedBytes: 0 });
  });

  test("over the cap the first and last lines survive and the marker names the count", () => {
    const t = lines(100);
    const r = capOutput(t, 200);
    expect(r.droppedBytes).toBeGreaterThan(0);
    expect(r.text.startsWith("line 000\n")).toBe(true);
    expect(r.text.endsWith("line 099")).toBe(true);
    expect(r.text).toContain(`[... ${r.droppedBytes} bytes dropped ...]`);
    const marker = `[... ${r.droppedBytes} bytes dropped ...]\n`;
    expect(bytes(r.text)).toBeLessThanOrEqual(200 + bytes(marker) + 1);
  });

  test("the dropped count is the bytes between the kept head and tail", () => {
    const t = lines(100);
    const r = capOutput(t, 200);
    const marker = `[... ${r.droppedBytes} bytes dropped ...]\n`;
    const kept = bytes(r.text) - bytes(marker);
    expect(kept + r.droppedBytes).toBe(bytes(t));
  });

  test("a multi-byte character at the cut is not split", () => {
    const t = "😀".repeat(50);
    for (const max of [10, 11, 12, 13, 30, 31]) {
      const r = capOutput(t, max);
      expect(r.text.includes("�")).toBe(false);
      const kept = r.text.replace(`[... ${r.droppedBytes} bytes dropped ...]\n`, "").replace("\n", "");
      expect(kept).toBe("😀".repeat(kept.length / 2));
      expect(bytes(kept) + r.droppedBytes).toBe(bytes(t));
    }
  });

  test("a headShare of zero keeps only the tail and of one only the head", () => {
    const t = lines(100);
    const tailOnly = capOutput(t, 200, 0);
    expect(tailOnly.text.startsWith("[... ")).toBe(true);
    expect(tailOnly.text.endsWith("line 099")).toBe(true);
    const headOnly = capOutput(t, 200, 1);
    expect(headOnly.text.startsWith("line 000\n")).toBe(true);
    expect(headOnly.text.endsWith("bytes dropped ...]\n")).toBe(true);
  });
});
