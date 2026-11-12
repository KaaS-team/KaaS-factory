package template

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const skillsDir = "../../template/.claude/skills"

// reportHeadings is the report format a cloud session pushes, in order.
var reportHeadings = []string{
	"BRANCH:",
	"HEAD:",
	"## Summary",
	"## Acceptance",
	"## API change requests",
	"## Files outside my area",
	"## Gate evidence",
	"## Learnings",
}

// skillFrontmatter returns the name and description of a SKILL.md, or an error.
func skillFrontmatter(text string) (name, desc string, err error) {
	rest, ok := strings.CutPrefix(text, "---\n")
	if !ok {
		return "", "", fmt.Errorf("no frontmatter")
	}
	block, _, ok := strings.Cut(rest, "\n---\n")
	if !ok {
		return "", "", fmt.Errorf("frontmatter not closed")
	}
	for _, line := range strings.Split(block, "\n") {
		if v, ok := strings.CutPrefix(line, "name:"); ok {
			name = strings.TrimSpace(v)
		}
		if v, ok := strings.CutPrefix(line, "description:"); ok {
			desc = strings.TrimSpace(v)
		}
	}
	return name, desc, nil
}

// missingHeadings lists the headings absent from the skill's report format block
// (the first fenced block under "## Report format"), or that are out of order.
func missingHeadings(text string) []string {
	_, after, ok := strings.Cut(text, "## Report format")
	if !ok {
		return reportHeadings
	}
	_, block, ok := strings.Cut(after, "```")
	if !ok {
		return reportHeadings
	}
	block, _, _ = strings.Cut(block, "```")
	block = "\n" + block
	var missing []string
	pos := 0
	for _, h := range reportHeadings {
		i := strings.Index(block[pos:], "\n"+h)
		if i < 0 {
			missing = append(missing, h)
			continue
		}
		pos += i + 1 + len(h)
	}
	return missing
}

// TestEverySkillHasFrontmatter covers every SKILL.md in the template: frontmatter
// present, name equals the directory, description under 1024 characters.
func TestEverySkillHasFrontmatter(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(skillsDir, "*", "SKILL.md"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no skills found: %v", err)
	}
	for _, f := range files {
		dir := filepath.Base(filepath.Dir(f))
		t.Run(dir, func(t *testing.T) {
			b, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			name, desc, err := skillFrontmatter(string(b))
			if err != nil {
				t.Fatal(err)
			}
			if name != dir {
				t.Errorf("name %q does not match directory %q", name, dir)
			}
			if desc == "" || len(desc) >= 1024 {
				t.Errorf("description length %d, want 1..1023", len(desc))
			}
		})
	}
}

func TestFrontmatterRules(t *testing.T) {
	cases := []struct {
		name, text string
		wantErr    bool
		wantName   string
	}{
		{"ok", "---\nname: a\ndescription: d\n---\nbody", false, "a"},
		{"none", "# a\n", true, ""},
		{"unclosed", "---\nname: a\n", true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n, _, err := skillFrontmatter(c.text)
			if (err != nil) != c.wantErr || n != c.wantName {
				t.Fatalf("got %q, %v", n, err)
			}
		})
	}
}

// TestCloudWorkerReportHeadings fails when the skill's report format loses a heading.
func TestCloudWorkerReportHeadings(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(skillsDir, "factory-cloud-worker", "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if m := missingHeadings(string(b)); len(m) > 0 {
		t.Errorf("report format is missing %q", m)
	}
}

func TestMissingHeadingsDetectsRemoval(t *testing.T) {
	full := "## Report format\n\n```\n" + strings.Join(reportHeadings, "\nx\n") + "\n```\n"
	if m := missingHeadings(full); len(m) != 0 {
		t.Fatalf("full format reported %q", m)
	}
	for _, h := range reportHeadings {
		cut := strings.Replace(full, h, "", 1)
		if m := missingHeadings(cut); len(m) != 1 || m[0] != h {
			t.Errorf("removing %q reported %q", h, m)
		}
	}
	if m := missingHeadings("no section"); len(m) != len(reportHeadings) {
		t.Errorf("no section reported %q", m)
	}
}

var modelName = regexp.MustCompile(`(?i)\b(claude-|sonnet|opus|haiku|fable)\b|sk-ant|ANTHROPIC_`)

// TestCloudWorkerTextIsClean forbids em dashes, model names and claude.ai links in the skill.
func TestCloudWorkerTextIsClean(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(skillsDir, "factory-cloud-worker", "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if strings.ContainsRune(s, '—') {
		t.Error("em dash in skill")
	}
	if m := modelName.FindString(s); m != "" {
		t.Errorf("model or key name %q in skill", m)
	}
	for _, bad := range []string{"claude.ai", "Claude-Session", "session_"} {
		if strings.Contains(s, bad) {
			t.Errorf("%q in skill", bad)
		}
	}
}
