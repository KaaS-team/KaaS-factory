package grade

import (
	"os/exec"
	"strings"
	"testing"
)

// log wraps test output the way Script does: start marker, output, end marker, exit code.
func log(out string, exit string) string {
	s := StartOutput + "\n" + out + "\n" + EndOutput + "\n"
	if exit != "" {
		s += ExitCode + ": " + exit + "\n"
	}
	return s
}

func TestGrade(t *testing.T) {
	pytest := func(lines ...string) string { return strings.Join(lines, "\n") }
	cases := []struct {
		name   string
		log    string
		fx     Spec
		valid  bool
		status ResolvedStatus
		reason string
	}{
		{"all pass", log(pytest("PASSED t::a", "PASSED t::b"), "0"), Spec{FailToPass: []string{"t::a"}, PassToPass: []string{"t::b"}}, true, ResolvedFull, ""},
		{"xfail counts as pass", log("XFAIL t::a", "0"), Spec{FailToPass: []string{"t::a"}}, true, ResolvedFull, ""},
		{"skipped F2P is a failure", log(pytest("SKIPPED t::a", "PASSED t::b"), "0"), Spec{FailToPass: []string{"t::a"}, PassToPass: []string{"t::b"}}, true, ResolvedNo, ""},
		{"skipped P2P is maintained", log(pytest("PASSED t::a", "SKIPPED t::b"), "0"), Spec{FailToPass: []string{"t::a"}, PassToPass: []string{"t::b"}}, true, ResolvedFull, ""},
		{"missing F2P test fails under pass_and_fail", log("PASSED t::other", "0"), Spec{FailToPass: []string{"t::a"}}, true, ResolvedNo, ""},
		{"failed P2P blocks partial", log(pytest("PASSED t::a", "FAILED t::b - boom", "PASSED t::c"), "1"), Spec{FailToPass: []string{"t::a", "t::c"}, PassToPass: []string{"t::b"}}, true, ResolvedNo, ""},
		{"partial F2P with P2P intact", log(pytest("PASSED t::a", "FAILED t::c - boom", "PASSED t::p"), "1"), Spec{FailToPass: []string{"t::a", "t::c"}, PassToPass: []string{"t::p"}}, true, ResolvedPartial, ""},
		{"error status fails", log("ERROR t::a", "1"), Spec{FailToPass: []string{"t::a"}}, true, ResolvedNo, ""},
		{"truncated parametrized id is not matched", log("PASSED t::a[log(photon)]", "0"), Spec{FailToPass: []string{"t::a[log(photon"}}, true, ResolvedNo, ""},
		{"skip summary line is not a test", log("SKIPPED [1] t.py:3: reason\nPASSED t::a", "0"), Spec{FailToPass: []string{"t::a"}, PassToPass: []string{"[1]"}}, true, ResolvedNo, ""},
		{"empty status map without evidence is invalid", log("collecting ...", "0"), Spec{FailToPass: []string{"t::a"}, EvalType: FailOnly}, false, ResolvedNo, "no test results"},
		{"empty status map with SUITE_RAN evidence under fail_only resolves", log("Tests: 3 passed", "0"), Spec{FailToPass: []string{"t::a"}, EvalType: FailOnly}, true, ResolvedFull, ""},
		{"zero count is not evidence", log("Executed 0 of 0", "0"), Spec{FailToPass: []string{"t::a"}, EvalType: FailOnly}, false, ResolvedNo, "no test results"},
		{"fail_only: absent counts as success, FAILED as failure", log("FAILED t::a - x", "1"), Spec{FailToPass: []string{"t::a"}, EvalType: FailOnly}, true, ResolvedNo, ""},
		{"fail_only: skipped is success", log("SKIPPED t::a\nPASSED t::z", "0"), Spec{FailToPass: []string{"t::a"}, EvalType: FailOnly}, true, ResolvedFull, ""},
		{"no markers", "PASSED t::a\n", Spec{FailToPass: []string{"t::a"}}, false, ResolvedNo, "markers"},
		{"start without end", StartOutput + "\nPASSED t::a\n", Spec{FailToPass: []string{"t::a"}}, false, ResolvedNo, "markers"},
		{"patch apply failed marker", ApplyFail + "\n" + log("PASSED t::a", "0"), Spec{FailToPass: []string{"t::a"}}, false, ResolvedNo, ApplyFail},
		{"reset failed marker", ResetFailed + "\n" + log("PASSED t::a", "0"), Spec{FailToPass: []string{"t::a"}}, false, ResolvedNo, ResetFailed},
		{"tests errored marker", TestsError + "\n" + log("PASSED t::a", "0"), Spec{FailToPass: []string{"t::a"}}, false, ResolvedNo, TestsError},
		{"timeout marker", TestsTimeout + "\n" + log("PASSED t::a", "0"), Spec{FailToPass: []string{"t::a"}}, false, ResolvedNo, TestsTimeout},
		{"exit code non-zero with no failure is invalid", log("PASSED t::a", "2"), Spec{FailToPass: []string{"t::a"}}, false, ResolvedNo, "exit code"},
		{"exit code non-zero with a failure is valid", log("PASSED t::a\nFAILED t::b - x", "1"), Spec{FailToPass: []string{"t::a"}, PassToPass: []string{"t::b"}}, true, ResolvedNo, ""},
		{"exit code absent is trusted", log("PASSED t::a", ""), Spec{FailToPass: []string{"t::a"}}, true, ResolvedFull, ""},
		{"forged exit code inside the test output is ignored", log("PASSED t::a\n"+ExitCode+": 0", "3"), Spec{FailToPass: []string{"t::a"}}, false, ResolvedNo, "exit code"},
		{"empty F2P and P2P resolve", log("PASSED t::a", "0"), Spec{}, true, ResolvedFull, ""},
		{"results outside the markers are used as a fallback", StartOutput + "\n" + EndOutput + "\nPASSED t::a\n", Spec{FailToPass: []string{"t::a"}}, true, ResolvedFull, ""},
		{"go test json", log(`{"Action":"pass","Package":"p","Test":"TestA"}`+"\n"+`{"Action":"fail","Package":"p","Test":"TestB"}`, "1"), Spec{Parser: ParserGoTest, FailToPass: []string{"p.TestA"}, PassToPass: []string{"p.TestB"}}, true, ResolvedNo, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := Grade(c.log, c.fx)
			if r.Valid != c.valid || r.Status != c.status || r.Resolved != (c.status == ResolvedFull) {
				t.Fatalf("got valid=%v status=%s resolved=%v reason=%q", r.Valid, r.Status, r.Resolved, r.Reason)
			}
			if !strings.Contains(r.Reason, c.reason) {
				t.Fatalf("reason %q does not contain %q", r.Reason, c.reason)
			}
		})
	}
}

func TestGradeListsEachTest(t *testing.T) {
	r := Grade(log("PASSED t::a\nFAILED t::b - x", "1"), Spec{FailToPass: []string{"t::a", "t::b"}})
	if len(r.FailToPass.Success) != 1 || r.FailToPass.Success[0] != "t::a" || len(r.FailToPass.Failure) != 1 || r.FailToPass.Failure[0] != "t::b" {
		t.Fatalf("%+v", r.FailToPass)
	}
}

func TestParsePytest(t *testing.T) {
	got := ParsePytest("PASSED a::x\nFAILED a::y - assert 1 == 2\nSKIPPED [3] f.py:1: why\nERROR a::z\nXFAIL a::w\nnoise\nPASSED\nPASSED a::x")
	want := map[string]Status{"a::x": Passed, "a::y": Failed, "a::z": Error, "a::w": XFail}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s: %v", k, got)
		}
	}
}

func TestParseGoTest(t *testing.T) {
	out := "building...\n" +
		`{"Action":"run","Package":"p","Test":"TestA"}` + "\n" +
		`{"Action":"output","Package":"p","Test":"TestA","Output":"x"}` + "\n" +
		`{"Action":"pass","Package":"p","Test":"TestA"}` + "\n" +
		`{"Action":"fail","Package":"p","Test":"TestA/sub"}` + "\n" +
		`{"Action":"skip","Package":"p","Test":"TestS"}` + "\n" +
		`{"Action":"fail","Package":"p"}` + "\n"
	got := ParseGoTest(out)
	want := map[string]Status{"p.TestA": Passed, "p.TestA/sub": Failed, "p.TestS": Skipped}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s: %v", k, got)
		}
	}
}

func TestScriptWritesExitCodeAfterEndMarker(t *testing.T) {
	s := Script("go test ./...")
	end, code := strings.Index(s, EndOutput), strings.Index(s, ExitCode)
	if !strings.Contains(s, StartOutput) || end < 0 || code < end {
		t.Fatalf("markers out of order:\n%s", s)
	}
	if !strings.Contains(s, "go test ./...") {
		t.Fatal("command missing")
	}
}

func TestScriptRecordsExitOfACommandThatExits(t *testing.T) {
	out, err := exec.Command("sh", "-c", Script("echo PASSED t::a; exit 3")).CombinedOutput()
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, ExitCode+": 3") || !strings.Contains(s, EndOutput) {
		t.Fatalf("%s", s)
	}
	// exit 3 with only PASSED lines must not grade as a pass
	if r := Grade(s, Spec{FailToPass: []string{"t::a"}}); r.Valid || r.Resolved {
		t.Fatalf("%+v", r)
	}
}
