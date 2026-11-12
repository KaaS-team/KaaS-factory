import { expect, test } from "bun:test";
import { formatDollars } from "../../src/money/cents";

test("format dollars", () => expect(formatDollars(1234)).toBe("$12.34"));
