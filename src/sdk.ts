// The supported surface for programs that embed the factory. A package outside the core imports
// this module and nothing else from src/ (tests/sdk-boundary.test.ts), so an internal can move
// without breaking one. Add a name here only when an embedder needs it.
export { signedBy } from "./chatops";
export { act, buildInbox, InboxError } from "./inbox";
export { LABEL } from "./labels";
export type { ScmPort } from "./ports/scm";
export { prItems } from "./stale-pr";
