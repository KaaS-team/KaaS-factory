package local

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

// The corpus is the upstream test table (command-guard.test.ts at cline@50e77bc) in Go form.
func TestGuardPassesReadOnlyCommands(t *testing.T) {
	for _, c := range []string{
		"ls -la", "pwd", "cat package.json", "head -n 50 src/index.ts", "tail -f /var/log/syslog",
		"grep -rn 'createShellTool' src/", "rg --files-with-matches 'ToolPresets'",
		"find . -name '*.ts' -not -path '*/node_modules/*'", "git status --short", "git log --oneline -20",
		"git diff HEAD~1", "git show HEAD:src/index.ts", "git blame src/index.ts", "git fetch origin main",
		"git branch --list", "wc -l src/*.ts", "du -sh node_modules", "df -h", "ps aux", "which node",
		"node --version", "npm ls --depth=0", "npm view zod versions", "bun run test", "bun test src/extensions",
		"cargo check", "cargo tree", "pip show requests", "brew list", "sed -n '1,20p' src/index.ts",
		"sed 's/foo/bar/' input.txt", "sort -u names.txt", "awk '{print $1}' data.csv",
		"awk '$3 > 100 {print}' data.csv", "diff a.txt b.txt", "curl -s https://example.com/api",
		"echo hello world", `printf '%s\n' one two`, "env | sort", "xargs -n1 echo < list.txt",
		"stat src/index.ts", "file dist/extension.js", "tree -L 2 src",
		// /dev sinks, fd duplication and /tmp capture
		"ls > /dev/null", "ls 2> /dev/null", "make check 2>&1 | tail -n 50", "echo warn >&2", "cmd &> /dev/null",
		"bun run build > /tmp/build.log 2>&1", "npm test >> /tmp/test-output.txt",
		"cargo build 2>&1 | tee /tmp/cargo.log", "long_cmd > $TMPDIR/out.log",
		// operators and names inside quotes or in argument position
		"grep '=>' src/index.ts", `echo "a > b"`, "git log --grep='rm -rf'", `rg "touch(ed)?" docs/`,
		"echo 'mkdir is a command'", "man rm", "which mv cp rm", "git log -- rm.txt", "cat mv-guide.md",
		"python3 <<'EOF'\nx = 10\nprint(x > 5)\nEOF", `echo a \> b`, "ls # > notes.txt",
		// review feedback cases
		"echo $(ls) done", "FOO=bar ls", "for f in *.log; do echo $f; done", "perl -Ilib script.pl",
		"awk '{print $1}' inplace-notes.txt", "git stash list", "git stash show -p", "git worktree list",
		"git submodule status", "git switch --help", "echo $((3 > 2))", `echo x > %TEMP%\out.log`,
		`echo x > $env:TEMP\out.log`, "curl -s https://x.test/api", "wget --spider https://x.test",
		"wget -qO- https://x.test | head", "python3 -m pip show requests", "python3 -m json.tool data.json",
		"go build ./...", "go test ./...", "dotnet build", "winget list", "yarn --version",
		"find . -type f -exec grep -l TODO {} +",
	} {
		if got := FindFileEditingCommand(c); got != "" {
			t.Errorf("%q refused as %s", c, got)
		}
	}
}

func TestGuardRefusesFileMutations(t *testing.T) {
	for _, c := range []struct{ cmd, want string }{
		{"rm -rf build", "`rm`"}, {"rm file.txt", "`rm`"}, {"mv a.txt b.txt", "`mv`"}, {"cp src.txt dst.txt", "`cp`"},
		{"touch new-file.ts", "`touch`"}, {"mkdir -p src/new-dir", "`mkdir`"}, {"chmod +x script.sh", "`chmod`"},
		{"chown user file", "`chown`"}, {"ln -s a b", "`ln`"}, {"truncate -s 0 log.txt", "`truncate`"},
		{"dd if=/dev/zero of=file bs=1M count=1", "`dd`"}, {"patch -p1 < fix.patch", "`patch`"},
		{"rsync -a src/ dst/", "`rsync`"}, {"install -m 755 bin/tool /usr/local/bin", "`install`"},
		{"del /f file.txt", "`del`"}, {"move a.txt b.txt", "`move`"}, {"Copy-Item a.txt b.txt", "`copy-item`"},
		{`Set-Content -Path f.txt -Value "x"`, "`set-content`"}, {`New-Item -ItemType File -Name "f"`, "`new-item`"},
		{`"hi" | Out-File out.txt`, "`out-file`"}, {"mi a.txt b.txt", "`mi`"}, {"ri -Force file.txt", "`ri`"},
		{"REMOVE-ITEM file.txt", "`remove-item`"}, {"Set-Content f.txt 'x'", "`set-content`"},
		{"echo hi > out.txt", "output redirection (`> out.txt`)"},
		{"echo 'export const x = 1' > src/new.ts", "output redirection (`> src/new.ts`)"},
		{"cat template.txt >> config.yaml", "output redirection (`> config.yaml`)"},
		{`printf 'y\n' > answers.txt`, "output redirection (`> answers.txt`)"},
		{"cmd &> output.log", "output redirection (`> output.log`)"}, {"ls 2> errors.txt", "output redirection (`> errors.txt`)"},
		{"cat > src/generated.ts <<'EOF'\nexport const x = 1\nEOF", "output redirection (`> src/generated.ts`)"},
		{"sed -i 's/a/b/' file.txt", "`sed -i` (in-place edit)"}, {"sed -ri 's/a/b/g' file.txt", "`sed -i` (in-place edit)"},
		{"sed --in-place=.bak 's/a/b/' file.txt", "`sed -i` (in-place edit)"}, {"gsed -i '' 's/a/b/' file.txt", "`sed -i` (in-place edit)"},
		{"sed -Ei 's/a/b/' f.txt", "`sed -i` (in-place edit)"},
		{"perl -pi -e 's/a/b/' file.txt", "`perl -i` (in-place edit)"}, {"perl -pi.bak -e 's/a/b/' f.txt", "`perl -i` (in-place edit)"},
		{`gawk -i inplace '{gsub(/a/,"b")}1' file.txt`, "`awk -i inplace` (in-place edit)"},
		{"gawk --include=inplace '{print}' f.txt", "`awk -i inplace` (in-place edit)"},
		{"sort -o sorted.txt input.txt", "`sort -o` (writes a file)"},
		{"ls | tee files.txt", "`tee`"}, {"cmd | tee -a build.log", "`tee`"}, {"ls | tee /tmp/../etc/passwd", "`tee`"},
		{"git add -A", "`git add`"}, {"git commit -m 'msg'", "`git commit`"}, {"git checkout main", "`git checkout`"},
		{"git restore src/index.ts", "`git restore`"}, {"git reset --hard HEAD~1", "`git reset`"}, {"git clean -fd", "`git clean`"},
		{"git apply fix.patch", "`git apply`"}, {"git stash", "`git stash`"}, {"git push origin main", "`git push`"},
		{"git pull", "`git pull`"}, {"git rebase main", "`git rebase`"}, {"git -C /repo -c user.name=x commit -m hi", "`git commit`"},
		{"git stash pop", "`git stash`"}, {"git worktree add ../wt", "`git worktree`"},
		{"npm install lodash", "`npm install`"}, {"npm i", "`npm i`"}, {"pnpm add -D vitest", "`pnpm add`"},
		{"yarn add react", "`yarn add`"}, {"bun add zod", "`bun add`"}, {"pip install requests", "`pip install`"},
		{"pip3 uninstall -y requests", "`pip3 uninstall`"}, {"cargo add serde", "`cargo add`"}, {"brew install jq", "`brew install`"},
		{"apt-get install -y curl", "`apt-get install`"}, {"winget install Some.App", "`winget install`"},
		{"nuget install Newtonsoft.Json", "`nuget install`"}, {"gem install rails", "`gem install`"},
		{"composer require vendor/pkg", "`composer require`"}, {"go install ./cmd/tool", "`go install`"},
		{"go get example.com/mod", "`go get`"}, {"dotnet add package Serilog", "`dotnet add`"},
		{"python -m pip install requests", "`pip install`"}, {"python3 -m pip uninstall -y requests", "`pip uninstall`"},
		{"yarn", "`yarn` (install)"},
		{"find . -name '*.log' -delete", "`find -delete`"}, {`find . -name '*.tmp' -exec rm {} \;`, "`rm`"},
		{"find . -type f -execdir chmod +x {} +", "`chmod`"}, {"find . -name '*.ts' | xargs -I {} rm {}", "`rm`"},
		{"curl -o src/out.ts https://x.test", "`curl -o` (writes a file)"}, {"curl -sSLo /workspace/file https://x.test", "`curl -o` (writes a file)"},
		{"curl --output out.bin https://x.test", "`curl -o` (writes a file)"}, {"wget https://x.test/file.zip", "`wget` (downloads files)"},
		// evasion by wrappers, later segments, substitution, assignments and reserved words
		{"sudo rm -rf /data", "`rm`"}, {"env FOO=1 mv a b", "`mv`"}, {"timeout 30 rm file", "`rm`"}, {"nohup cp a b", "`cp`"},
		{"xargs rm < list.txt", "`rm`"}, {"command rm file", "`rm`"}, {"cd /tmp && rm -rf cache", "`rm`"},
		{"ls; touch marker", "`touch`"}, {"true || rm file", "`rm`"}, {"ls | tee out.txt | wc -l", "`tee`"},
		{"echo $(rm file)", "`rm`"}, {"echo `touch marker`", "`touch`"}, {"FOO=bar rm file", "`rm`"},
		{"for f in *.log; do rm $f; done", "`rm`"}, {"if true; then touch x; fi", "`touch`"},
		{"echo x > /tmp/../home/user/project/src/index.ts", "output redirection (`> /tmp/../home/user/project/src/index.ts`)"},
		{`echo x > C:\project\out.log`, "output redirection (`> C:_roject_ut.log`)"},
	} {
		if got := FindFileEditingCommand(c.cmd); got != c.want {
			t.Errorf("%q: got %q, want %q", c.cmd, got, c.want)
		}
	}
}

func planArgv(t *testing.T, in ClaudeInput) []string {
	t.Helper()
	in.ReadOnly, in.Stage, in.Issue = true, "plan", "7"
	argv, err := ClaudeArgv(in)
	if err != nil {
		t.Fatal(err)
	}
	return argv
}

func flag(argv []string, name string) string {
	for i, a := range argv {
		if a == name && i+1 < len(argv) {
			return argv[i+1]
		}
	}
	return ""
}

func TestPlanPresetRemovesEditTools(t *testing.T) {
	for _, stage := range []string{"triage", "plan", "build", "verify", "pr", "retro"} {
		argv, err := ClaudeArgv(ClaudeInput{Stage: stage, Issue: "7", ReadOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		for _, tool := range strings.Split(flag(argv, "--tools"), ",") {
			if tool == "Write" || tool == "Edit" || tool == "NotebookEdit" {
				t.Errorf("%s keeps %s", stage, tool)
			}
		}
		if strings.Contains(flag(argv, "--settings"), `"Edit(`) {
			t.Errorf("%s keeps an Edit allow rule", stage)
		}
	}
	if got := flag(planArgv(t, ClaudeInput{}), "--tools"); got != "Bash,Read,Skill,Agent" {
		t.Errorf("plan tools %q", got)
	}
	// A run that is not read-only is unchanged.
	argv, _ := ClaudeArgv(ClaudeInput{Stage: "plan", Issue: "7"})
	if got := flag(argv, "--tools"); got != "Bash,Read,Write,Skill,Agent" {
		t.Errorf("default plan tools %q", got)
	}
}

func TestPlanPresetKeepsReadOnlyAllowlistAndDropsWrites(t *testing.T) {
	settingsJSON := flag(planArgv(t, ClaudeInput{Commands: Commands{Read: []string{"rg *", "rm *", "git clean *", "make check"}}}), "--settings")
	var dropped []string
	for _, p := range readOnlyBash {
		if strings.Contains(settingsJSON, `"Bash(`+p+`)"`) {
			continue
		}
		dropped = append(dropped, p)
	}
	if want := []string{"mkdir -p *"}; !reflect.DeepEqual(dropped, want) {
		t.Errorf("dropped from the default read-only allowlist: %q, want %q", dropped, want)
	}
	for _, p := range []string{"rg *", "make check"} {
		if !strings.Contains(settingsJSON, `"Bash(`+p+`)"`) {
			t.Errorf("read-only %q was dropped", p)
		}
	}
	for _, p := range []string{"rm *", "git clean *"} {
		if strings.Contains(settingsJSON, p) {
			t.Errorf("write pattern %q is auto-approved in a plan run", p)
		}
	}
}

func TestClaudePlanPresetIsDefaultAndReadOnly(t *testing.T) {
	d, err := New(context.Background(), Config{Worktrees: dirWorktrees{t.TempDir()}})
	if err != nil {
		t.Fatal(err)
	}
	p, ok := d.cfg.Presets["claude-plan"]
	if !ok {
		t.Fatal("claude-plan is not a default preset")
	}
	argv, err := p.Argv(Run{Brief: bf, Stage: "plan", Budget: 1})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(flag(argv, "--tools"), "Write") {
		t.Errorf("claude-plan argv has Write: %q", argv)
	}
}
