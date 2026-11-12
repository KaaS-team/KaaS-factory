package config

import (
	"errors"
	"io/fs"
)

// Repo layer file names under the repo root. The JSON file is the alias products/kaas uses.
const (
	RepoFileYAML = ".factory/factory.yaml"
	RepoFileJSON = ".factory/config.json"
)

// ReadRepo reads the repo layer from the repo root fsys: factory.yaml when present, otherwise
// config.json (JSON is read as YAML). It returns an empty Source when neither file exists.
func ReadRepo(fsys fs.FS) (Source, error) {
	for _, name := range []string{RepoFileYAML, RepoFileJSON} {
		data, err := fs.ReadFile(fsys, name)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return Source{}, err
		}
		return Source{Name: name, Data: data}, nil
	}
	return Source{}, nil
}
