import { expect, test } from "bun:test";
import { mul } from "../../src/add";

test("mul", () => expect(mul(3, 4)).toBe(12));
