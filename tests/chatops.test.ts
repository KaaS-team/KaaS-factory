import { expect, test } from "bun:test";
import { parseChatOps } from "../src/chatops";

test("retry parses --force and a step", () => {
  expect(parseChatOps("/factory retry")).toEqual({ type: "retry" });
  expect(parseChatOps("/factory retry --force")).toEqual({ type: "retry", force: true });
  expect(parseChatOps("/factory retry plan")).toEqual({ type: "retry", step: "plan" });
  expect(parseChatOps("/factory retry --force build")).toEqual({ type: "retry", force: true, step: "build" });
  expect(parseChatOps("/factory retry Not A Step!")).toEqual({ type: "retry" });
});
