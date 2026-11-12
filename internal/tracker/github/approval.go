package github

import "context"

// PlanApproval returns the id of the comment that approves the latest plan in the thread, or 0.
// Approval is a trusted `/factory approve` comment posted after that plan and not yet handled, and
// no later revise or cancel has voided it. The task text, an earlier comment, a plain-text "ok" or a
// UI toggle never count, so act cannot start in the turn that wrote the plan.
func PlanApproval(ctx context.Context, tr *Trust, cs []Comment) int64 {
	plan := -1
	for i, c := range cs {
		if _, ok := Latest(ParseData(c.Body), stagePlan); ok && tr.Trusted(ctx, c.Author) {
			plan = i
		}
	}
	if plan < 0 {
		return 0
	}
	done := acked(cs)
	var ref int64
	for _, c := range cs[plan+1:] {
		cmd, ok := tr.Command(ctx, c)
		if !ok {
			continue
		}
		switch cmd.Kind {
		case CmdApprove:
			if !done[c.ID] {
				ref = c.ID
			}
		case CmdRevise, CmdCancel:
			ref = 0
		}
	}
	return ref
}
