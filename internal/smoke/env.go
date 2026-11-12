// Package smoke drives the real factory loop against one GitHub repository with a fake agent
// (no model), so an operator can check the whole path end to end. See docs/smoke.md.
package smoke

import (
	"encoding/base64"
	"fmt"
	"strings"
)

// Environment variable names the live test reads.
const (
	EnvRepo  = "FACTORY_SMOKE_REPO"
	EnvToken = "GITHUB_TOKEN"
)

// Env is the sandbox repository and the token that acts on it.
type Env struct {
	Owner, Repo string
	Token       string
}

// FromEnv reads the sandbox settings with getenv. When something is missing or malformed it
// returns the reason a test should give for skipping, and a zero Env.
func FromEnv(getenv func(string) string) (Env, string) {
	repo, token := strings.TrimSpace(getenv(EnvRepo)), strings.TrimSpace(getenv(EnvToken))
	switch {
	case repo == "" && token == "":
		return Env{}, EnvRepo + " and " + EnvToken + " are not set"
	case repo == "":
		return Env{}, EnvRepo + " is not set"
	case token == "":
		return Env{}, EnvToken + " is not set"
	}
	owner, name, ok := strings.Cut(repo, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return Env{}, fmt.Sprintf("%s %q is not owner/name", EnvRepo, repo)
	}
	return Env{Owner: owner, Repo: name, Token: token}, ""
}

// GitAuthEnv returns the environment entries that make git send token to github.com over HTTPS.
// They travel in the environment, so the token is on no command line and in no remote URL.
func GitAuthEnv(token string) map[string]string {
	basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
	return map[string]string{
		"GIT_CONFIG_COUNT":   "1",
		"GIT_CONFIG_KEY_0":   "http.https://github.com/.extraheader",
		"GIT_CONFIG_VALUE_0": "Authorization: Basic " + basic,
	}
}
