package config

import "fmt"

// Explanation says what a key resolved to and which layer set it.
type Explanation struct {
	Key    string
	Value  any
	Winner Layer
}

// Explain reports the resolved value of key and the layer that set it.
func (l *Loaded) Explain(key string) (Explanation, error) {
	if _, ok := lookup(key); !ok {
		return Explanation{}, fmt.Errorf("unknown key %q", key)
	}
	ex := Explanation{Key: key}
	ex.Value, _ = l.Config.Get(key)
	for _, layer := range Layers() {
		if _, ok := l.layers[layer][key]; ok {
			ex.Winner = layer
		}
	}
	return ex, nil
}
