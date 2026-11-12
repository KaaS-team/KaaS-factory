package core

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/KaaS-team/factory/internal/graph/interrupt"
	gh "github.com/KaaS-team/factory/internal/tracker/github"
	_ "modernc.org/sqlite"
)

// The plan-approval wait is a durable interrupt: it is stored when the ticket parks, and the
// /factory approve answer is checked against its schema and consumed when the ticket resumes.
func TestPlanApprovalIsADurableInterrupt(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "i.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	book, err := interrupt.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	r, tt, _ := parkedRigWith(t, book)
	ctx := context.Background()
	// The human node id comes from the workflow, so find the thread in the table.
	var thread string
	if err := db.QueryRow(`SELECT thread FROM interrupts`).Scan(&thread); err != nil {
		t.Fatalf("no interrupt stored when the ticket parked: %v", err)
	}
	if p, _ := book.Pending(ctx, thread); len(p) != 1 || len(p[0].Schema) == 0 {
		t.Fatalf("pending %v", p)
	}
	tt.comments = append(tt.comments, gh.Comment{ID: 1, Author: "maintainer", Body: "/factory approve"})
	r.c.Tick(ctx)
	if _, ok := r.disp.Sessions["5-a2"]; !ok {
		t.Fatalf("approve did not resume: %v", r.disp.Sessions)
	}
	if p, _ := book.Pending(ctx, thread); len(p) != 0 {
		t.Fatalf("interrupt still pending after resume: %v", p)
	}
	var n int
	_ = db.QueryRow(`SELECT count(*) FROM interrupts`).Scan(&n)
	if n != 0 {
		t.Fatalf("answered interrupt not cleared: %d rows", n)
	}
}

// A Store that can hold interrupts makes plan approval durable with no extra wiring.
func TestNewTakesInterruptsFromStore(t *testing.T) {
	r, _, _ := parkedRig(t)
	if r.c.d.Interrupts == nil {
		t.Fatal("Deps.Interrupts was not filled from the store")
	}
}
