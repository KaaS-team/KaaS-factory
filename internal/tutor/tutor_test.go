package tutor_test

import (
	"testing"

	"github.com/KaaS-team/factory/internal/tutor"
)

func TestNext(t *testing.T) {
	p := tutor.Policy{Student: "small", Teacher: "large", MaxStudentAttempts: 2, TeacherVerifies: true}
	off := p
	off.TeacherVerifies = false
	rejS, rejSelf, rejT := tutor.Attempt{Tier: "small"}, tutor.Attempt{Tier: "small"}, tutor.Attempt{Tier: "large"}
	cases := []struct {
		name    string
		p       tutor.Policy
		history []tutor.Attempt
		want    tutor.Decision
	}{
		{"first attempt", p, nil, tutor.Decision{Tier: "small", Review: true, ReviewTier: "large"}},
		{"first attempt, verify off", off, nil, tutor.Decision{Tier: "small"}},
		{"within student budget", p, []tutor.Attempt{{Tier: "small"}}, tutor.Decision{Tier: "small", Review: true, ReviewTier: "large"}},
		{"within budget after teacher reject", p, []tutor.Attempt{rejS}, tutor.Decision{Tier: "small", Review: true, ReviewTier: "large"}},
		{"budget exhausted", p, []tutor.Attempt{{Tier: "small"}, {Tier: "small"}}, tutor.Decision{Tier: "large"}},
		{"budget exhausted, verify off", off, []tutor.Attempt{{Tier: "small"}, {Tier: "small"}}, tutor.Decision{Tier: "large"}},
		{"reject not by teacher", off, []tutor.Attempt{rejSelf}, tutor.Decision{Tier: "small"}},
		{"teacher reject at exhaustion", p, []tutor.Attempt{{Tier: "small"}, rejS}, tutor.Decision{Tier: "large"}},
		{"teacher attempt rejected", p, []tutor.Attempt{{Tier: "small"}, {Tier: "small"}, rejT}, tutor.Decision{Tier: "large"}},
		{"zero budget goes straight to teacher", tutor.Policy{Student: "small", Teacher: "large"}, nil, tutor.Decision{Tier: "large"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.p.Next(c.history); got != c.want {
				t.Fatalf("got %+v want %+v", got, c.want)
			}
		})
	}
}
