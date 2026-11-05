// Preload for `bun test` under scripts/test-watchdog.ts: records which test is running in this process, so the
// watchdog can name a hung one. Bun has no API for the current test name, hence the wrapper around test().
import * as bt from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FACTORY_HANG_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, `${process.pid}.json`);
  const wrap = (orig: typeof bt.test): typeof bt.test => {
    const run = (name: string, fn: unknown, opts?: unknown) => {
      if (typeof fn !== "function") return (orig as any)(name, fn, opts);
      const body =
        (fn as (...a: unknown[]) => unknown).length > 0
          ? (done: unknown) => track(name, () => fn(done))
          : () => track(name, () => fn());
      return (orig as any)(name, body, opts);
    };
    const get = (t: object, k: string | symbol) => {
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    };
    return new Proxy(orig, { apply: (_t, _this, args) => run(...(args as [string, unknown, unknown])), get });
  };
  const track = (name: string, f: () => unknown): unknown => {
    writeFileSync(marker, JSON.stringify({ file: Bun.main, name, start: Date.now() }));
    const end = () => rmSync(marker, { force: true });
    let out: unknown;
    try {
      out = f();
    } catch (e) {
      end();
      throw e;
    }
    if (out && typeof (out as Promise<unknown>).then === "function") return (out as Promise<unknown>).finally(end);
    end();
    return out;
  };
  const test = wrap(bt.test);
  bt.mock.module("bun:test", () => ({ ...bt, test, it: test }));
}
