package tutor_test

import (
	"os"
	"regexp"
	"testing"

	"github.com/KaaS-team/factory/internal/tutor"
)

func TestNext(t *testing.T) {
	p := tutor.Policy{Student: "small", Teacher: "large", MaxStudentAttempts: 2, TeacherVerifies: true}
	off := p
	off.TeacherVerifies = false
	rejS := tutor.Attempt{Tier: "small", Verdict: tutor.Reject, ReviewedBy: "large"}
	rejSelf := tutor.Attempt{Tier: "small", Verdict: tutor.Reject}
	rejT := tutor.Attempt{Tier: "large", Verdict: tutor.Reject, ReviewedBy: "large"}
	cases := []struct {
		name    string
		p       tutor.Policy
		history []tutor.Attempt
		want    tutor.Decision
	}{
		{"first attempt", p, nil, tutor.Decision{Tier: "small", Review: true, ReviewTier: "large"}},
		{"first attempt, verify off", off, nil, tutor.Decision{Tier: "small"}},
		{"within student budget", p, []tutor.Attempt{{Tier: "small"}}, tutor.Decision{Tier: "small", Review: true, ReviewTier: "large"}},
		{"within budget after teacher reject writes lesson", p, []tutor.Attempt{rejS}, tutor.Decision{Tier: "small", Review: true, ReviewTier: "large", WriteLesson: true}},
		{"budget exhausted", p, []tutor.Attempt{{Tier: "small"}, {Tier: "small"}}, tutor.Decision{Tier: "large"}},
		{"budget exhausted, verify off", off, []tutor.Attempt{{Tier: "small"}, {Tier: "small"}}, tutor.Decision{Tier: "large"}},
		{"reject not by teacher writes no lesson", off, []tutor.Attempt{rejSelf}, tutor.Decision{Tier: "small"}},
		{"teacher reject at exhaustion", p, []tutor.Attempt{{Tier: "small"}, rejS}, tutor.Decision{Tier: "large", WriteLesson: true}},
		{"teacher attempt rejected", p, []tutor.Attempt{{Tier: "small"}, {Tier: "small"}, rejT}, tutor.Decision{Tier: "large", WriteLesson: true}},
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

func lesson() tutor.Lesson {
	return tutor.Lesson{Ticket: "ENG-42", Rule: "[check] Add a test that walks every route.", Evidence: "Attempt 1 on small tier shipped an unguarded route."}
}

func TestLessonGolden(t *testing.T) {
	want, err := os.ReadFile("testdata/lesson.golden.md")
	if err != nil {
		t.Fatal(err)
	}
	if got := lesson().Render(); got != string(want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestLessonHasNoModelName(t *testing.T) {
	re := regexp.MustCompile(`(?i)claude|opus|sonnet|haiku|fable|gpt|gemini|llama|mistral|\d+(\.\d+)?[bk]\b`)
	if m := re.FindString(lesson().Render()); m != "" {
		t.Fatalf("model name %q in lesson", m)
	}
	if err := (tutor.Lesson{Ticket: "1", Rule: "uses claude-opus-5-5", Evidence: "x"}).Validate(); err == nil {
		t.Fatal("Validate accepted a model name")
	}
}
