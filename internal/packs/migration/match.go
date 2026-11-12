package migration

import (
	"encoding/json"
	"errors"
	"io/fs"
	"strings"
)

// Match reports whether the file passes the predicate. A file that cannot be read fails content
// checks; a manifest that cannot be parsed is an error.
func (p Predicate) Match(fsys fs.FS, file string) (bool, error) {
	switch {
	case p.And != nil:
		return all(p.And, fsys, file)
	case p.Or != nil:
		for _, q := range p.Or {
			if ok, err := q.Match(fsys, file); ok || err != nil {
				return ok, err
			}
		}
		return false, nil
	case p.Not != nil:
		ok, err := p.Not.Match(fsys, file)
		return !ok && err == nil, err
	case p.glob != nil:
		return p.glob.MatchString(file), nil
	case p.re != nil:
		b, err := fs.ReadFile(fsys, file)
		return err == nil && p.re.Match(b), nil
	case p.Dep != nil:
		return p.Dep.match(fsys)
	}
	return false, errors.New("empty predicate")
}

// MatchAll reports whether the file passes every predicate; no predicates match everything.
func MatchAll(ps []Predicate, fsys fs.FS, file string) (bool, error) { return all(ps, fsys, file) }

func all(ps []Predicate, fsys fs.FS, file string) (bool, error) {
	for _, q := range ps {
		if ok, err := q.Match(fsys, file); !ok || err != nil {
			return false, err
		}
	}
	return true, nil
}

func (d *Dependency) match(fsys fs.FS) (bool, error) {
	for _, m := range []string{"package.json", "go.mod"} {
		if d.Manifest != "" && d.Manifest != m {
			continue
		}
		b, err := fs.ReadFile(fsys, m)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, err
		}
		deps, err := parseManifest(m, b)
		if err != nil {
			return false, err
		}
		if v, ok := deps[d.Name]; ok {
			if len(d.rng) == 0 {
				return true, nil
			}
			if have, err := parseVersion(v); err == nil && inRange(d.rng, have) {
				return true, nil
			}
		}
	}
	return false, nil
}

func parseManifest(name string, b []byte) (map[string]string, error) {
	deps := map[string]string{}
	if name == "package.json" {
		var m struct {
			Dependencies, DevDependencies, PeerDependencies map[string]string
		}
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, errors.New("package.json: " + err.Error())
		}
		for _, set := range []map[string]string{m.PeerDependencies, m.DevDependencies, m.Dependencies} {
			for k, v := range set {
				deps[k] = v
			}
		}
		return deps, nil
	}
	inBlock := false
	for _, line := range strings.Split(string(b), "\n") {
		line, _, _ = strings.Cut(line, "//")
		f := strings.Fields(line)
		switch {
		case len(f) == 2 && f[0] == "require" && f[1] == "(":
			inBlock = true
		case inBlock && len(f) == 1 && f[0] == ")":
			inBlock = false
		case inBlock && len(f) == 2:
			deps[f[0]] = f[1]
		case !inBlock && len(f) == 3 && f[0] == "require":
			deps[f[1]] = f[2]
		}
	}
	return deps, nil
}
