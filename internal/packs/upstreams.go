package packs

import (
	"encoding/json"
	"fmt"
	"strings"
)

type upstream struct {
	Repo    string `json:"repo"`
	SHA     string `json:"sha"`
	Licence string `json:"licence"`
	Files   []struct {
		From   string `json:"from"`
		To     string `json:"to"`
		SHA256 string `json:"sha256"`
	} `json:"files"`
}

// FromUpstreams converts blueprint's upstreams.json (repo, sha, licence, files of from, to, sha256) into lock entries.
// The kind comes from the skills, agents, workflows or checks directory in each file's "to" path.
func FromUpstreams(data []byte) ([]Entry, error) {
	var ups []upstream
	if err := json.Unmarshal(data, &ups); err != nil {
		return nil, fmt.Errorf("upstreams.json: %w", err)
	}
	var out []Entry
	for _, u := range ups {
		for _, f := range u.Files {
			kind, err := kindOfPath(f.To)
			if err != nil {
				return nil, err
			}
			slug := u.Repo
			ref, err := ParseRef(slug + "@" + u.SHA + "#" + f.From)
			if err != nil {
				return nil, fmt.Errorf("upstreams.json %s: %w", u.Repo, err)
			}
			if f.SHA256 == "" {
				return nil, fmt.Errorf("upstreams.json %s: %s has no sha256", u.Repo, f.From)
			}
			out = append(out, Entry{Kind: kind, Ref: ref.String(), SHA: u.SHA, SHA256: f.SHA256, Licence: u.Licence})
		}
	}
	return out, nil
}

func kindOfPath(to string) (Kind, error) {
	for _, seg := range strings.Split(to, "/") {
		switch seg {
		case "skills":
			return KindSkill, nil
		case "agents":
			return KindAgent, nil
		case "workflows":
			return KindWorkflow, nil
		case "checks":
			return KindCheck, nil
		}
	}
	return "", fmt.Errorf("upstreams.json: cannot tell the kind of %s", to)
}
