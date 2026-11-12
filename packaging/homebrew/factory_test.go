package homebrew

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestFormulaTemplateMatchesGoreleaserArchives: every os/arch goreleaser builds has a formula url
// with the archive name its name_template produces, and the formula names no other archive.
func TestFormulaTemplateMatchesGoreleaserArchives(t *testing.T) {
	cfg, err := os.ReadFile("../../.goreleaser.yaml")
	if err != nil {
		t.Fatal(err)
	}
	tmpl, err := os.ReadFile("factory.rb.tmpl")
	if err != nil {
		t.Fatal(err)
	}
	nameTmpl := regexp.MustCompile(`name_template: "(factory_[^"]*\.tar\.gz|factory_[^"]*)"`).FindStringSubmatch(string(cfg))
	if nameTmpl == nil {
		t.Fatal("archive name_template not found in .goreleaser.yaml")
	}
	ext := ""
	if strings.Contains(string(cfg), "formats: [tar.gz]") && !strings.HasSuffix(nameTmpl[1], ".tar.gz") {
		ext = ".tar.gz"
	}
	for _, p := range []struct{ os, arch string }{{"darwin", "amd64"}, {"darwin", "arm64"}, {"linux", "amd64"}, {"linux", "arm64"}} {
		name := strings.NewReplacer("{{ .Os }}", p.os, "{{ .Arch }}", p.arch).Replace(nameTmpl[1]) + ext
		if !strings.Contains(string(tmpl), "/"+name+`"`) {
			t.Errorf("formula has no url for %s", name)
		}
	}
	if n := len(regexp.MustCompile(`factory_\w+_\w+\.tar\.gz`).FindAllString(string(tmpl), -1)); n != 4 {
		t.Errorf("formula names %d archives, want 4", n)
	}
	if !strings.Contains(string(tmpl), `"version"`) {
		t.Error("formula test block must run factory version")
	}
}
