// Ported from ossf/scorecard@4ddc782c70ebba1d65f0dd1b3470f24ed4ea18b1 pkg/scorecard/sarif.go
//
// Copyright 2021 OpenSSF Scorecard Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package sarif

import (
	"encoding/json"
	"sort"
)

const schemaURL = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json"

type text struct {
	Text string `json:"text"`
}

type suppression struct {
	Kind          string `json:"kind"`
	Justification string `json:"justification"`
}

type result struct {
	RuleID       string        `json:"ruleId"`
	Level        string        `json:"level"`
	Message      text          `json:"message"`
	Locations    []any         `json:"locations,omitempty"`
	Suppressions []suppression `json:"suppressions,omitempty"`
}

type rule struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	ShortDescription text   `json:"shortDescription"`
}

// Marshal renders findings as one SARIF 2.1.0 run. Suppressed findings stay in the results with a
// suppression carrying their reason, so a code-scanning view shows them as dismissed.
func Marshal(version string, kept []Finding, suppressed []Suppressed) ([]byte, error) {
	results := []result{}
	rules := map[string]rule{}
	add := func(f Finding, s *Suppressed) {
		rules[f.ID] = rule{ID: f.ID, Name: f.Title, ShortDescription: text{f.Title}}
		msg := f.Detail
		if msg == "" {
			msg = f.Title
		}
		r := result{RuleID: f.ID, Level: level(f.Severity), Message: text{msg}}
		if f.File != "" {
			region := map[string]any{"startLine": max(f.Line, 1)}
			r.Locations = []any{map[string]any{"physicalLocation": map[string]any{
				"artifactLocation": map[string]any{"uri": f.File}, "region": region}}}
		}
		if s != nil {
			r.Suppressions = []suppression{{Kind: "external", Justification: string(s.Reason) + ": " + s.Reason.Doc()}}
		}
		results = append(results, r)
	}
	for _, f := range kept {
		add(f, nil)
	}
	for i := range suppressed {
		add(suppressed[i].Finding, &suppressed[i])
	}
	rs := make([]rule, 0, len(rules))
	for _, r := range rules {
		rs = append(rs, r)
	}
	sort.Slice(rs, func(i, j int) bool { return rs[i].ID < rs[j].ID })
	doc := map[string]any{"$schema": schemaURL, "version": "2.1.0", "runs": []any{map[string]any{
		"tool": map[string]any{"driver": map[string]any{
			"name": "factory first-run", "version": version, "rules": rs}},
		"results": results,
	}}}
	return json.MarshalIndent(doc, "", "  ")
}

// level maps an auditor severity to a SARIF level.
func level(sev string) string {
	switch sev {
	case "fail":
		return "error"
	case "warn":
		return "warning"
	default:
		return "note"
	}
}
