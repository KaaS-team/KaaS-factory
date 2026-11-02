import { describe, expect, test } from "bun:test";
import { parseRepos, waitingOn } from "../src/change-set";

describe("parseRepos", () => {
  test("two entries parse in order", () => {
    expect(parseRepos("Repos: a/b#1, c/d#2")).toEqual([
      { repo: "a/b", issue: 1 },
      { repo: "c/d", issue: 2 },
    ]);
  });

  test("none, an empty body and a body without the line give an empty list", () => {
    expect(parseRepos("Repos: none")).toEqual([]);
    expect(parseRepos("")).toEqual([]);
    expect(parseRepos("just some text\nBlocked by: #3")).toEqual([]);
  });

  test("duplicate entries collapse to one", () => {
    expect(parseRepos("Repos: a/b#1, c/d#2, a/b#1")).toEqual([
      { repo: "a/b", issue: 1 },
      { repo: "c/d", issue: 2 },
    ]);
  });

  test("a malformed entry is skipped", () => {
    expect(parseRepos("Repos: a/b#x, c/d#2, nonsense")).toEqual([{ repo: "c/d", issue: 2 }]);
  });

  test("the first line wins", () => {
    expect(parseRepos("Repos: a/b#1\nRepos: c/d#2")).toEqual([{ repo: "a/b", issue: 1 }]);
  });
});

describe("waitingOn", () => {
  const set = parseRepos("Repos: a/b#1, c/d#2, e/f#3, g/h#4");

  test("merged is not waiting; open, closed and unknown are, in listed order", () => {
    const state = new Map<string, "open" | "merged" | "closed">([
      ["a/b#1", "merged"],
      ["c/d#2", "open"],
      ["e/f#3", "closed"],
    ]);
    expect(waitingOn(set, state)).toEqual(["c/d#2", "e/f#3", "g/h#4"]);
  });

  test("everything merged leaves nothing waiting", () => {
    const state = new Map<string, "open" | "merged" | "closed">(set.map((e) => [`${e.repo}#${e.issue}`, "merged"]));
    expect(waitingOn(set, state)).toEqual([]);
  });
});
