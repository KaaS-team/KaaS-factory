package budget

import (
	"errors"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// DefaultPath is where budgets live.
const DefaultPath = ".factory/budgets.yaml"

type file struct {
	Budgets []Budget `yaml:"budgets"`
}

// Parse reads budgets from YAML and validates them. Unknown keys are an error.
func Parse(data []byte) ([]Budget, error) {
	var f file
	dec := yaml.NewDecoder(bytesReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&f); err != nil && !errors.Is(err, errEOF) {
		return nil, fmt.Errorf("budget: %w", err)
	}
	if err := Validate(f.Budgets); err != nil {
		return nil, err
	}
	return f.Budgets, nil
}

// Load reads path. A missing file means no budgets.
func Load(path string) ([]Budget, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Parse(data)
}
