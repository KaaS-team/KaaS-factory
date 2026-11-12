package packs

import "testing"

func TestParseRef(t *testing.T) {
	sha := "1401c8b8030e023baeebb31781a6653fe8e93026"
	good := []struct {
		in   string
		want Ref
	}{
		{"owner/repo@" + sha + "#skills/x/SKILL.md", Ref{Owner: "owner", Repo: "repo", SHA: sha, Path: "skills/x/SKILL.md"}},
		{"owner/repo#LICENSE", Ref{Owner: "owner", Repo: "repo", Path: "LICENSE"}},
		{"a-b/c.d_e@abcdef1#p/q", Ref{Owner: "a-b", Repo: "c.d_e", SHA: "abcdef1", Path: "p/q"}},
	}
	for _, c := range good {
		got, err := ParseRef(c.in)
		if err != nil {
			t.Fatalf("%q: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("%q: got %+v want %+v", c.in, got, c.want)
		}
		if got.String() != c.in {
			t.Errorf("round trip %q gave %q", c.in, got.String())
		}
	}
	bad := []string{
		"", "owner/repo", "owner/repo@" + sha, "owner/repo#", "#path", "owner#path", "/repo#p",
		"owner/@abc1234#p", "owner/repo@#p", "owner/repo@XYZ#p", "owner/repo@abc#p",
		"owner/repo@" + sha + "0#p", "a/b/c#p", "owner/repo#../x", "owner/repo#/abs", "owner/repo#a/../b",
		"owner/repo @abc1234#p", "owner/repo#a b",
	}
	for _, in := range bad {
		if r, err := ParseRef(in); err == nil {
			t.Errorf("%q: want error, got %+v", in, r)
		}
	}
}
