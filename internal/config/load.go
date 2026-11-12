package config

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/env/v2"
	"github.com/knadh/koanf/providers/posflag"
	"github.com/knadh/koanf/providers/rawbytes"
	"github.com/knadh/koanf/v2"
	"github.com/spf13/pflag"
)

// EnvPrefix starts every environment variable this package reads.
const EnvPrefix = "FACTORY_"

// Source is the text of one file layer and the name used when an error mentions it.
type Source struct {
	Name string
	Data []byte
}

// Sources holds the input of every layer. Env is a list of KEY=VALUE pairs, normally os.Environ().
// Flags is a flag set made by RegisterFlags; only flags the user set take part.
type Sources struct {
	Org, Team, Repo Source
	Env             []string
	Flags           *pflag.FlagSet
}

// layerValues is the coerced, normalized key to value map one layer sets.
type layerValues map[string]any

// Loaded is the result of Load: the resolved Config and what each layer set.
type Loaded struct {
	Config  Config
	layers  map[Layer]layerValues
	names   map[Layer]string
	clamped map[string]bool // keys whose resolved value came from the org layer's clamp
}

// RegisterFlags adds one flag per fixed key, named by its key path, to fs. Models tiers are set
// through the model-tier flag "models.<tier>" only when the caller adds it.
func RegisterFlags(fs *pflag.FlagSet) {
	for _, sp := range specs {
		if sp.kind == kList {
			fs.StringSlice(sp.key, nil, "list for "+sp.key)
		} else {
			fs.String(sp.key, "", "value for "+sp.key)
		}
	}
	fs.String("models.fast", "", "model for tier fast")
}

// Load resolves the layers into a Config.
func Load(s Sources) (*Loaded, error) {
	l := &Loaded{layers: map[Layer]layerValues{}, names: map[Layer]string{}, clamped: map[string]bool{}}
	l.layers[LayerBuiltin] = builtin()
	files := []struct {
		layer Layer
		src   Source
	}{{LayerOrg, s.Org}, {LayerTeam, s.Team}, {LayerRepo, s.Repo}}
	for _, f := range files {
		if len(f.src.Data) == 0 {
			continue
		}
		k := koanf.New(".")
		if err := k.Load(rawbytes.Provider(f.src.Data), yaml.Parser()); err != nil {
			return nil, fmt.Errorf("%s layer %s: %w", f.layer, f.src.Name, err)
		}
		vals, err := fromKoanf(k, f.layer == LayerOrg || f.layer == LayerTeam)
		if err != nil {
			return nil, fmt.Errorf("%s layer %s: %w", f.layer, f.src.Name, err)
		}
		l.layers[f.layer], l.names[f.layer] = vals, f.src.Name
	}
	if len(s.Env) > 0 {
		k := koanf.New(".")
		err := k.Load(env.Provider(".", env.Opt{
			Prefix:      EnvPrefix,
			EnvironFunc: func() []string { return s.Env },
			TransformFunc: func(k, v string) (string, any) {
				return strings.ToLower(strings.TrimPrefix(k, EnvPrefix)), v
			},
		}), nil)
		if err != nil {
			return nil, fmt.Errorf("env layer: %w", err)
		}
		vals, err := fromEnv(k)
		if err != nil {
			return nil, fmt.Errorf("env layer: %w", err)
		}
		l.layers[LayerEnv] = vals
	}
	if s.Flags != nil {
		k := koanf.New(".")
		if err := k.Load(posflag.Provider(s.Flags, ".", nil), nil); err != nil {
			return nil, fmt.Errorf("flags layer: %w", err)
		}
		vals, err := fromKoanf(k, false)
		if err != nil {
			return nil, fmt.Errorf("flags layer: %w", err)
		}
		l.layers[LayerFlags] = vals
	}
	if err := l.checkCeilings(); err != nil {
		return nil, err
	}
	l.resolve()
	l.clamp()
	return l, nil
}

func builtin() layerValues {
	out := layerValues{}
	for _, sp := range specs {
		out[sp.key] = sp.def
	}
	return out
}

// fromKoanf coerces every key a koanf layer holds. Org and team files may also carry the
// factory-config metadata keys and "policy" aliases.
func fromKoanf(k *koanf.Koanf, allowFactoryConfig bool) (layerValues, error) {
	return collect(k.All(), allowFactoryConfig, func(key string) string { return key })
}

// fromEnv maps FACTORY_BUDGETS_TEAM_DAY style names to keys and coerces their values.
func fromEnv(k *koanf.Koanf) (layerValues, error) {
	raw := map[string]any{}
	for name, v := range k.All() {
		raw[envKey(name)] = v
	}
	return collect(raw, false, func(key string) string { return EnvPrefix + strings.ToUpper(strings.ReplaceAll(key, ".", "_")) })
}

// collect resolves each raw key to a spec and coerces its value. Every unknown key is reported,
// sorted, with its full path; label names a key in a type error.
func collect(raw map[string]any, allowFactoryConfig bool, label func(string) string) (layerValues, error) {
	out := layerValues{}
	var unknown, bad []string
	for key, v := range raw {
		if allowFactoryConfig {
			if ignored, alias := factoryConfigKey(key); ignored {
				continue
			} else if alias != "" {
				key = alias
			}
		}
		sp, ok := lookup(key)
		if !ok {
			unknown = append(unknown, key)
			continue
		}
		if v == nil {
			continue
		}
		cv, err := coerce(sp, v)
		if err != nil {
			bad = append(bad, fmt.Sprintf("%s: %v", label(key), err))
			continue
		}
		out[key] = cv
	}
	sort.Strings(unknown)
	sort.Strings(bad)
	var errs []error
	for _, key := range unknown {
		errs = append(errs, fmt.Errorf("unknown key %q", key))
	}
	for _, m := range bad {
		errs = append(errs, errors.New(m))
	}
	return out, errors.Join(errs...)
}

// factoryConfigKey classifies a key of a factory-config org or team file: ignored metadata, or an
// alias to the key it sets here.
func factoryConfigKey(key string) (ignored bool, alias string) {
	top, rest, _ := strings.Cut(key, ".")
	if foreign[top] {
		return true, ""
	}
	if top != "policy" {
		return false, ""
	}
	if a, ok := policyAlias[key]; ok {
		return false, a
	}
	second, _, _ := strings.Cut(rest, ".")
	return foreignPolicy[second], ""
}

// envKey turns a lowercased variable name without the prefix into a key path.
func envKey(name string) string {
	for _, sp := range specs {
		if strings.ReplaceAll(sp.key, ".", "_") == name {
			return sp.key
		}
	}
	if tier, ok := strings.CutPrefix(name, "models_"); ok {
		return "models." + tier
	}
	return name
}

// resolve overlays the layers in order and fills Config.
func (l *Loaded) resolve() {
	for _, layer := range Layers() {
		for key, v := range l.layers[layer] {
			l.Config.put(key, v)
		}
	}
}

// clamp applies the org value of the keys whose ceiling resolves instead of failing: shadow stays
// on when the org turned it on, and trust.min_role never drops below the org's role.
func (l *Loaded) clamp() {
	for _, sp := range specs {
		orgVal, ok := l.layers[LayerOrg][sp.key]
		if !ok {
			continue
		}
		cur, _ := l.Config.Get(sp.key)
		switch sp.ceil {
		case ceilForceTrue:
			if orgVal == true && cur != true {
				l.Config.put(sp.key, true)
				l.clamped[sp.key] = true
			}
		case ceilFloor:
			if slices.Index(roles, cur.(string)) < slices.Index(roles, orgVal.(string)) {
				l.Config.put(sp.key, orgVal)
				l.clamped[sp.key] = true
			}
		}
	}
}
