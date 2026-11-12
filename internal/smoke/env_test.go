package smoke

import "testing"

func TestFromEnv(t *testing.T) {
	cases := []struct {
		name       string
		env        map[string]string
		wantSkip   string
		wantOwner  string
		wantRepo   string
		wantTokenN string
	}{
		{"both set", map[string]string{"FACTORY_SMOKE_REPO": "acme/sandbox", "GITHUB_TOKEN": "tok"}, "", "acme", "sandbox", "tok"},
		{"nothing set", map[string]string{}, "FACTORY_SMOKE_REPO and GITHUB_TOKEN are not set", "", "", ""},
		{"repo missing", map[string]string{"GITHUB_TOKEN": "tok"}, "FACTORY_SMOKE_REPO is not set", "", "", ""},
		{"token missing", map[string]string{"FACTORY_SMOKE_REPO": "acme/sandbox"}, "GITHUB_TOKEN is not set", "", "", ""},
		{"blank values", map[string]string{"FACTORY_SMOKE_REPO": "  ", "GITHUB_TOKEN": " "}, "FACTORY_SMOKE_REPO and GITHUB_TOKEN are not set", "", "", ""},
		{"no slash", map[string]string{"FACTORY_SMOKE_REPO": "sandbox", "GITHUB_TOKEN": "tok"}, `FACTORY_SMOKE_REPO "sandbox" is not owner/name`, "", "", ""},
		{"extra slash", map[string]string{"FACTORY_SMOKE_REPO": "a/b/c", "GITHUB_TOKEN": "tok"}, `FACTORY_SMOKE_REPO "a/b/c" is not owner/name`, "", "", ""},
		{"empty owner", map[string]string{"FACTORY_SMOKE_REPO": "/b", "GITHUB_TOKEN": "tok"}, `FACTORY_SMOKE_REPO "/b" is not owner/name`, "", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e, skip := FromEnv(func(k string) string { return c.env[k] })
			if skip != c.wantSkip {
				t.Fatalf("skip = %q, want %q", skip, c.wantSkip)
			}
			if e.Owner != c.wantOwner || e.Repo != c.wantRepo || e.Token != c.wantTokenN {
				t.Fatalf("env = %+v", e)
			}
		})
	}
}

func TestGitAuthEnv(t *testing.T) {
	got := GitAuthEnv("tok")
	want := map[string]string{
		"GIT_CONFIG_COUNT":   "1",
		"GIT_CONFIG_KEY_0":   "http.https://github.com/.extraheader",
		"GIT_CONFIG_VALUE_0": "Authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9r", // base64 of x-access-token:tok
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if len(got) != len(want) {
		t.Errorf("got %d entries, want %d", len(got), len(want))
	}
}
