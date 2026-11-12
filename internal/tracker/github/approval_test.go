package github_test

import (
	"context"
	"testing"
	"time"

	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

const planBody = "Plan.\n\n<!-- factory:data {\"stage\":\"plan\",\"json\":{\"goal\":\"g\"}} -->"

// TestPlanApproval covers the rule that approval is an explicit later-turn comment on a plan already
// posted (Symphony spec section 10.5: approval is an action, not part of the task text).
func TestPlanApproval(t *testing.T) {
	tr := gh.NewTrust("bot", roles(map[string]gh.Role{"dev": gh.RoleWrite, "reader": gh.RoleRead}), time.Now)
	plan := gh.Comment{ID: 10, Author: "bot", Body: planBody}
	ack := gh.Comment{ID: 13, Author: "bot", Body: "Handled.\n\n<!-- factory:data {\"stage\":\"chatops\",\"json\":{\"ref\":12}} -->"}
	cases := []struct {
		name   string
		thread []gh.Comment
		want   int64
	}{
		{"no plan posted", []gh.Comment{{ID: 1, Author: "dev", Body: "/factory approve"}}, 0},
		{"approve in the task text before the plan", []gh.Comment{{ID: 1, Author: "dev", Body: "do X /factory approve"}, {ID: 2, Author: "dev", Body: "/factory approve"}, plan}, 0},
		{"approve after the plan", []gh.Comment{plan, {ID: 12, Author: "dev", Body: "/factory approve"}}, 12},
		{"approve by a reader", []gh.Comment{plan, {ID: 12, Author: "reader", Body: "/factory approve"}}, 0},
		{"approve already handled", []gh.Comment{plan, {ID: 12, Author: "dev", Body: "/factory approve"}, ack}, 0},
		{"revise after approve voids it", []gh.Comment{plan, {ID: 12, Author: "dev", Body: "/factory approve"}, {ID: 14, Author: "dev", Body: "/factory revise smaller"}}, 0},
		{"cancel after approve voids it", []gh.Comment{plan, {ID: 12, Author: "dev", Body: "/factory approve"}, {ID: 14, Author: "dev", Body: "/factory cancel"}}, 0},
		{"revised plan needs a new approve", []gh.Comment{plan, {ID: 12, Author: "dev", Body: "/factory approve"}, {ID: 14, Author: "dev", Body: "/factory revise x"}, {ID: 15, Author: "bot", Body: planBody}}, 0},
		{"new approve on the revised plan", []gh.Comment{plan, {ID: 14, Author: "dev", Body: "/factory revise x"}, {ID: 15, Author: "bot", Body: planBody}, {ID: 16, Author: "dev", Body: "/factory approve"}}, 16},
		{"plain text is not approval", []gh.Comment{plan, {ID: 12, Author: "dev", Body: "approved, go ahead"}}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := gh.PlanApproval(context.Background(), tr, tc.thread); got != tc.want {
				t.Fatalf("approval ref = %d, want %d", got, tc.want)
			}
		})
	}
}
