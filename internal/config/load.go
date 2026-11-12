package config

import (
	"fmt"
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
	Config Config
	layers map[Layer]layerValues
	names  map[Layer]string
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
	l := &Loaded{layers: map[Layer]layerValues{}, names: map[Layer]string{}}
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
		vals, err := fromKoanf(k, f.layer, f.layer == LayerOrg || f.layer == LayerTeam)
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
		vals, err := fromKoanf(k, LayerFlags, false)
		if err != nil {
			return nil, fmt.Errorf("flags layer: %w", err)
		}
		l.layers[LayerFlags] = vals
	}
	l.resolve()
	return l, nil
}

func builtin() layerValues {
	out := layerValues{}
	for _, sp := range specs {
		out[sp.key] = sp.def
	}
	return out
}

// fromKoanf coerces every key a koanf layer holds.
func fromKoanf(k *koanf.Koanf, layer Layer, allowForeign bool) (layerValues, error) {
	out := layerValues{}
	for key, raw := range k.All() {
		if raw == nil {
			continue
		}
		sp, ok := lookup(key)
		if !ok {
			continue
		}
		v, err := coerce(sp, raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", key, err)
		}
		out[key] = v
	}
	return out, nil
}

// fromEnv maps FACTORY_BUDGETS_TEAM_DAY style names to keys and coerces their values.
func fromEnv(k *koanf.Koanf) (layerValues, error) {
	out := layerValues{}
	for name, raw := range k.All() {
		key := envKey(name)
		sp, ok := lookup(key)
		if !ok {
			continue
		}
		v, err := coerce(sp, raw)
		if err != nil {
			return nil, fmt.Errorf("%s%s: %w", EnvPrefix, strings.ToUpper(name), err)
		}
		out[key] = v
	}
	return out, nil
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
