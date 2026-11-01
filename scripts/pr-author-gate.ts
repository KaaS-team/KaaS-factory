// `bun scripts/pr-author-gate.ts <login> <author_association>` prints "keep", or "close" and the pointer.
import { readFileSync } from "node:fs";
import { APPROVED_FILE, closePointer, decidePr, parseApproved } from "../src/contributor-policy";

if (import.meta.main) {
  const [login = "", association = ""] = process.argv.slice(2);
  const approved = parseApproved(readFileSync(`${import.meta.dir}/../${APPROVED_FILE}`, "utf8"));
  const verdict = decidePr({ login, association }, approved);
  console.log(verdict === "keep" ? "keep" : `close\n${closePointer()}`);
}
