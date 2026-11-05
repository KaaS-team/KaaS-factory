// bun scripts/delete-merged-branches.ts <owner/repo> [branch]
// With a branch: delete it if its PR merged. Without: sweep every merged feat/* branch.
import { GhCommandRunner } from "../src/github";
import { deleteIfMerged, sweepMerged } from "../src/merged-branches";

const [repo, branch] = process.argv.slice(2);
if (!repo) throw new Error("usage: delete-merged-branches.ts <owner/repo> [branch]");
const gh = new GhCommandRunner();
if (branch) console.log(`${branch}: ${await deleteIfMerged(gh, repo, branch)}`);
else console.log(`deleted ${JSON.stringify(await sweepMerged(gh, repo))}`);
