// Package tutor decides which model tier runs each attempt: a cheap student
// tier first, a stronger teacher tier once the student budget is spent. It
// names tiers (small, large), never models.
package tutor

// Policy is the escalation rule for one run.
type Policy struct {
	Student            string
	Teacher            string
	MaxStudentAttempts int
	TeacherVerifies    bool
}

// Attempt is one finished build attempt and the tier it ran on.
type Attempt struct {
	Tier string
}

// Decision says what the next attempt runs on and what follows it.
type Decision struct {
	Tier       string // tier that builds the next attempt
	Review     bool   // a review of that attempt runs
	ReviewTier string // tier that reviews it, when Review is set
}

// Next picks the tier for the next attempt from the attempts so far.
// A teacher-built attempt is never reviewed by the teacher: the author does
// not grade its own work.
func (p Policy) Next(history []Attempt) Decision {
	students := 0
	for _, a := range history {
		if a.Tier == p.Student {
			students++
		}
	}
	d := Decision{Tier: p.Student}
	if students >= p.MaxStudentAttempts {
		d.Tier = p.Teacher
	}
	if p.TeacherVerifies && d.Tier != p.Teacher {
		d.Review, d.ReviewTier = true, p.Teacher
	}
	return d
}
