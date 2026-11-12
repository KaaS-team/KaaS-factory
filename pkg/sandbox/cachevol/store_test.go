//go:build linux

package cachevol

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const mib = 1 << 20

// fill writes n bytes into a volume's contents directory.
func fill(t *testing.T, dir string, n int) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "blob"), make([]byte, n), 0o644); err != nil {
		t.Fatal(err)
	}
}

func open(t *testing.T, dir string, now func() time.Time) *Store {
	t.Helper()
	s, err := Open(dir, Options{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestIdentityIDIncludesTenant(t *testing.T) {
	base := Identity{Tenant: "a", Namespace: "n", Key: "go-build", Sharing: "shared", Owner: "o", Source: "sha256:x"}
	if len(base.ID()) != 64 {
		t.Fatalf("id not a stable sha-256 hex: %q", base.ID())
	}
	for name, mut := range map[string]func(*Identity){
		"tenant": func(i *Identity) { i.Tenant = "b" }, "namespace": func(i *Identity) { i.Namespace = "m" },
		"key": func(i *Identity) { i.Key = "k" }, "sharing": func(i *Identity) { i.Sharing = "private" },
		"owner": func(i *Identity) { i.Owner = "p" }, "source": func(i *Identity) { i.Source = "sha256:y" },
	} {
		other := base
		mut(&other)
		if other.ID() == base.ID() {
			t.Errorf("changing %s did not change the id", name)
		}
	}
}

func TestOpenSingleOwner(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, nil)
	if _, err := Open(dir, Options{}); !errors.Is(err, ErrOwned) {
		t.Fatalf("second Open: got %v, want ErrOwned", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s2, err := Open(dir, Options{})
	if err != nil {
		t.Fatalf("Open after Close: %v", err)
	}
	_ = s2.Close()
}

func TestAcquireCreatesOnceAndFailedPopulateLeavesNothing(t *testing.T) {
	s := open(t, t.TempDir(), nil)
	id := Identity{Tenant: "a", Key: "k"}
	if _, err := s.Acquire(t.Context(), id, true, func(context.Context, string) error { return errors.New("boom") }); err == nil {
		t.Fatal("failed populate returned a pin")
	}
	if ents, _ := os.ReadDir(filepath.Join(s.formDir, "volumes")); len(ents) != 0 {
		t.Fatalf("failed populate left %d volumes", len(ents))
	}
	calls := 0
	populate := func(_ context.Context, d string) error { calls++; fill(t, d, 10); return nil }
	p1, err := s.Acquire(t.Context(), id, false, populate)
	if err != nil || !p1.Created() || !p1.FirstPin() {
		t.Fatalf("first acquire: %v created=%v", err, p1 != nil && p1.Created())
	}
	p2, err := s.Acquire(t.Context(), id, false, populate)
	if err != nil || p2.Created() || p2.FirstPin() || calls != 1 {
		t.Fatalf("second acquire: %v calls=%d", err, calls)
	}
	other, _ := s.Acquire(t.Context(), Identity{Tenant: "b", Key: "k"}, false, populate)
	if other.Path() == p1.Path() || calls != 2 {
		t.Fatal("a different tenant shared a volume")
	}
}

// collectFixture makes three 2 MiB volumes, a oldest, c newest, and pins the volume named by pin.
func collectFixture(t *testing.T, pin string) (*Store, map[string]Identity) {
	t.Helper()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s := open(t, t.TempDir(), func() time.Time { return now })
	ids := map[string]Identity{}
	for _, k := range []string{"a", "b", "c"} {
		ids[k] = Identity{Tenant: "t", Key: k}
		p, err := s.Acquire(t.Context(), ids[k], true, func(_ context.Context, d string) error { fill(t, d, 2*mib); return nil })
		if err != nil {
			t.Fatal(err)
		}
		if k != pin {
			p.Release()
		}
		now = now.Add(2 * time.Hour)
	}
	return s, ids
}

func TestCollectPolicy(t *testing.T) {
	for _, tc := range []struct {
		name    string
		policy  Policy
		pin     string
		removed []string
	}{
		{"under cap removes nothing", Policy{MaxUsedSpace: 100 * mib}, "", nil},
		{"max used removes least recently used first", Policy{MaxUsedSpace: 9 * mib / 2}, "", []string{"a"}},
		{"max used keeps going until under the cap", Policy{MaxUsedSpace: 5 * mib / 2}, "", []string{"a", "b"}},
		{"min free frees the shortfall", Policy{MinFreeSpace: 10 * mib, CurrentFreeSpace: 7 * mib}, "", []string{"a", "b"}},
		{"pinned volume is skipped", Policy{MaxUsedSpace: 1}, "a", []string{"b", "c"}},
		{"all still skips pinned", Policy{All: true}, "c", []string{"a", "b"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := collectFixture(t, tc.pin)
			rep, err := s.Collect(t.Context(), tc.policy)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.WaitRemovals(t.Context()); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, e := range rep.Removed {
				got = append(got, e.Identity.Key)
			}
			if strings.Join(got, ",") != strings.Join(tc.removed, ",") {
				t.Fatalf("removed %v, want %v", got, tc.removed)
			}
			if tc.pin != "" {
				if _, err := os.Stat(filepath.Join(s.volumeDir(Identity{Tenant: "t", Key: tc.pin}.ID()), fsName)); err != nil {
					t.Fatalf("pinned volume gone: %v", err)
				}
			}
		})
	}
}

func TestPolicyTargetBytes(t *testing.T) {
	for _, tc := range []struct {
		name string
		p    Policy
		used int64
		want int64
	}{
		{"unset", Policy{}, 10, 0},
		{"over max", Policy{MaxUsedSpace: 6}, 10, 4},
		{"reserved floors the cap", Policy{MaxUsedSpace: 6, ReservedSpace: 8}, 10, 2},
		{"under max", Policy{MaxUsedSpace: 60}, 10, 0},
		{"min free short", Policy{MinFreeSpace: 9, CurrentFreeSpace: 4}, 10, 5},
		{"min free limited by reserved", Policy{MinFreeSpace: 90, CurrentFreeSpace: 4, ReservedSpace: 7}, 10, 3},
		{"min free met", Policy{MinFreeSpace: 4, CurrentFreeSpace: 9}, 10, 0},
		{"both take the larger", Policy{MaxUsedSpace: 6, MinFreeSpace: 9, CurrentFreeSpace: 1}, 10, 8},
	} {
		if got := tc.p.targetBytes(tc.used); got != tc.want {
			t.Errorf("%s: got %d, want %d", tc.name, got, tc.want)
		}
	}
}

// TestKillNineLeavesConsistentDirectory runs a child that dies with SIGKILL inside populate, then
// checks the next owner finds no partial volume, takes the lock and can recreate the volume.
func TestKillNineLeavesConsistentDirectory(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperDieInPopulate$")
	cmd.Env = append(os.Environ(), "CACHEVOL_HELPER_DIR="+dir)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(out)
	for sc.Scan() && sc.Text() != "populating" {
	}
	if _, err := Open(dir, Options{}); !errors.Is(err, ErrOwned) {
		t.Fatalf("child should own the directory, got %v", err)
	}
	if err := cmd.Process.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()

	s, err := Open(dir, Options{})
	if err != nil {
		t.Fatalf("Open after kill: %v", err)
	}
	defer func() { _ = s.Close() }()
	for _, sub := range []string{"tmp", "trash", "volumes"} {
		if ents, _ := os.ReadDir(filepath.Join(s.formDir, sub)); len(ents) != 0 {
			t.Fatalf("%s holds %d entries after recovery", sub, len(ents))
		}
	}
	p, err := s.Acquire(t.Context(), Identity{Key: "k"}, false, nil)
	if err != nil || !p.Created() {
		t.Fatalf("recreate: %v", err)
	}
}

func TestHelperDieInPopulate(t *testing.T) {
	dir := os.Getenv("CACHEVOL_HELPER_DIR")
	if dir == "" {
		t.Skip("helper for TestKillNineLeavesConsistentDirectory")
	}
	s, err := Open(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s.Acquire(context.Background(), Identity{Key: "k"}, true, func(_ context.Context, d string) error {
		fill(t, d, mib)
		_, _ = os.Stdout.WriteString("populating\n")
		time.Sleep(time.Minute)
		return nil
	})
}

func TestDirtyVolumeIsRemeasuredAfterKill(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, nil)
	p, _ := s.Acquire(t.Context(), Identity{Key: "k"}, true, func(_ context.Context, d string) error { fill(t, d, mib); return nil })
	p.Release()
	if _, used, _ := s.Usage(t.Context()); used < mib {
		t.Fatalf("used %d", used)
	}
	p, _ = s.Acquire(t.Context(), Identity{Key: "k"}, true, nil) // the marker comes back before any write
	fill(t, p.Path(), 3*mib)
	s.abandon()
	s2 := open(t, dir, nil)
	if _, used, err := s2.Usage(t.Context()); err != nil || used < 3*mib {
		t.Fatalf("stale size kept: used=%d err=%v", used, err)
	}
}
