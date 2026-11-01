// A PR that keeps failing review is usually the wrong approach, so past the cap a person decides.
// Rounds are verify rejects: the cap is the round whose failure hands over, so one fewer rejects fit.
export const rejectLimit = (workflowRejects: number, maxRounds: number): number =>
  Math.min(workflowRejects, maxRounds - 1);

export const rejectedNote = (round: number, maxRounds: number): string =>
  `rejected ${round} times${round >= maxRounds ? "; review cap reached, rethink the approach instead of patching again" : ""}`;
