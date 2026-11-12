// Ported from ossf/scorecard@4ddc782c70ebba1d65f0dd1b3470f24ed4ea18b1 config/annotations.go
//
// Copyright 2024 OpenSSF Scorecard Authors
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

// Package sarif reads reason-tagged annotations and writes first-run findings as SARIF 2.1.0.
package sarif

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"gopkg.in/yaml.v3"
)

// Reason is why a maintainer suppresses a finding.
type Reason string

// The reasons scorecard defines; an annotation must use one of them.
const (
	TestData      Reason = "test-data"
	Remediated    Reason = "remediated"
	NotApplicable Reason = "not-applicable"
	NotSupported  Reason = "not-supported"
	NotDetected   Reason = "not-detected"
)

// ReasonGroup holds one reason of an annotation.
type ReasonGroup struct {
	Reason Reason `yaml:"reason"`
}

// Annotation suppresses the finding ids in Checks for the given reasons.
type Annotation struct {
	Checks  []string      `yaml:"checks"`
	Reasons []ReasonGroup `yaml:"reasons"`
}

// Config is the annotations file.
type Config struct {
	Annotations []Annotation `yaml:"annotations"`
}

// Doc returns the human-readable explanation of a reason, or the reason itself when unknown.
func (r Reason) Doc() string {
	switch r {
	case TestData:
		return "The files or code snippets are only used for test or example purposes."
	case Remediated:
		return "The dangerous files or code snippets are necessary but remediations were already applied."
	case NotApplicable:
		return "The check is not applicable in this case."
	case NotSupported:
		return "The check is fulfilled but in a way that is not supported."
	case NotDetected:
		return "The check is fulfilled but it was not detected."
	default:
		return string(r)
	}
}

var (
	errInvalidCheck  = errors.New("check is not valid")
	errInvalidReason = errors.New("reason is not valid")
	errNoReason      = errors.New("annotation has no reason")
)

// ParseAnnotations reads and validates an annotations file. Unlike scorecard it has no fixed list
// of checks, so a check is valid when it is not blank; an annotation needs at least one known reason.
func ParseAnnotations(r io.Reader) (Config, error) {
	var c Config
	b, err := io.ReadAll(r)
	if err != nil {
		return c, fmt.Errorf("read annotations: %w", err)
	}
	if err := yaml.Unmarshal(b, &c); err != nil {
		return Config{}, fmt.Errorf("parse annotations: %w", err)
	}
	for _, a := range c.Annotations {
		for _, id := range a.Checks {
			if strings.TrimSpace(id) == "" {
				return Config{}, errInvalidCheck
			}
		}
		if len(a.Reasons) == 0 {
			return Config{}, errNoReason
		}
		for _, g := range a.Reasons {
			switch g.Reason {
			case TestData, Remediated, NotApplicable, NotSupported, NotDetected:
			default:
				return Config{}, fmt.Errorf("%w: %s", errInvalidReason, g.Reason)
			}
		}
	}
	return c, nil
}

// Finding is the part of an auditor finding the SARIF output needs.
type Finding struct {
	ID       string
	Title    string
	Severity string
	File     string
	Line     int
	Detail   string
}

// Suppressed is a finding a maintainer annotated, with the first reason given.
type Suppressed struct {
	Finding Finding
	Reason  Reason
}

// Reason returns the reason an annotation gives for suppressing the finding id, matching without
// regard to case.
func (c Config) Reason(id string) (Reason, bool) {
	for _, a := range c.Annotations {
		for _, x := range a.Checks {
			if strings.EqualFold(x, id) {
				return a.Reasons[0].Reason, true
			}
		}
	}
	return "", false
}
