package config

import (
	"fmt"
	"strings"
)

// Attempt is one layer that set a key: the value it set and the file it came from, if any.
type Attempt struct {
	Layer  Layer
	Value  any
	Source string
}

// Explanation says what a key resolved to, which layer set it and which layers it overrode.
type Explanation struct {
	Key      string
	Value    any
	Winner   Layer
	Overrode []Layer   // lower layers that also set the key, lowest first
	Tried    []Attempt // every layer that set the key, lowest first, the winner last
}

// Explain reports the resolved value of key, the layer that set it and every layer that tried.
func (l *Loaded) Explain(key string) (Explanation, error) {
	if _, ok := lookup(key); !ok {
		return Explanation{}, fmt.Errorf("unknown key %q", key)
	}
	ex := Explanation{Key: key}
	ex.Value, _ = l.Config.Get(key)
	for _, layer := range Layers() {
		if v, ok := l.layers[layer][key]; ok {
			ex.Tried = append(ex.Tried, Attempt{Layer: layer, Value: v, Source: l.names[layer]})
		}
	}
	if n := len(ex.Tried); n > 0 {
		ex.Winner = ex.Tried[n-1].Layer
		for _, a := range ex.Tried[:n-1] {
			ex.Overrode = append(ex.Overrode, a.Layer)
		}
	}
	if l.clamped[key] {
		ex.Winner = LayerOrg
	}
	return ex, nil
}

// String renders the one line `config explain` prints: key, value, winner and what it overrode.
func (e Explanation) String() string {
	line := fmt.Sprintf("%s = %v (%s)", e.Key, e.Value, e.Winner)
	if len(e.Overrode) == 0 {
		return line
	}
	names := make([]string, len(e.Overrode))
	for i, o := range e.Overrode {
		names[i] = string(o)
	}
	return line + ", overrode " + strings.Join(names, ", ")
}
