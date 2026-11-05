// bun scripts/rerun-cancelled.ts <owner/repo> <run id>: restart a cancelled ci run nothing superseded.
import { rerunIfCancelled } from "../src/ci-cancelled";
import { GhCommandRunner } from "../src/github";

const [repo, id] = process.argv.slice(2);
if (!repo || !Number(id)) throw new Error("usage: rerun-cancelled.ts <owner/repo> <run id>");
const d = await rerunIfCancelled(new GhCommandRunner(), repo, Number(id));
console.log(d.rerun ? `reran run ${id}` : `left run ${id} alone: ${d.reason}`);
