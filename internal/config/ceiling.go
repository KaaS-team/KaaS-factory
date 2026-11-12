package config

import (
	"errors"
	"fmt"
	"slices"
	"sort"
)

// ErrCeiling is wrapped by every error that reports a lower layer going past the org ceiling.
var ErrCeiling = errors.New("config: org ceiling exceeded")

// checkCeilings reports every key a layer below the org sets past what the org layer allows.
// A key the org does not set has no ceiling.
func (l *Loaded) checkCeilings() error {
	org := l.layers[LayerOrg]
	var errs []error
	for _, layer := range []Layer{LayerTeam, LayerRepo, LayerEnv, LayerFlags} {
		keys := make([]string, 0, len(l.layers[layer]))
		for key := range l.layers[layer] {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			orgVal, ok := org[key]
			if !ok {
				continue
			}
			sp, _ := lookup(key)
			if why := breach(sp, orgVal, l.layers[layer][key]); why != "" {
				errs = append(errs, fmt.Errorf("%w: %s: %s layer%s %s; org layer%s %s", ErrCeiling, key,
					layer, l.where(layer), why, l.where(LayerOrg), describeCeiling(sp, orgVal)))
			}
		}
	}
	return errors.Join(errs...)
}

func (l *Loaded) where(layer Layer) string {
	if n := l.names[layer]; n != "" {
		return " (" + n + ")"
	}
	return ""
}

// breach says how lower goes past the org value, or returns "" when it stays within it.
func breach(sp spec, orgVal, lower any) string {
	switch sp.ceil {
	case ceilMax:
		o, _ := toFloat(orgVal)
		v, _ := toFloat(lower)
		if v > o {
			return fmt.Sprintf("sets %v, above the ceiling", lower)
		}
	case ceilSubset:
		allowed, _ := orgVal.([]string)
		for _, e := range lower.([]string) {
			if !slices.Contains(allowed, e) {
				return fmt.Sprintf("adds %q, which is not in the allow-list", e)
			}
		}
	case ceilRisk:
		if slices.Index(risks, lower.(string)) > slices.Index(risks, orgVal.(string)) {
			return fmt.Sprintf("sets %v, riskier than the ceiling", lower)
		}
	case ceilFalse:
		if orgVal == false && lower == true {
			return "turns on what the org turned off"
		}
	case ceilTrue:
		if orgVal == true && lower == false {
			return "turns off what the org requires"
		}
	}
	return ""
}

func describeCeiling(sp spec, orgVal any) string {
	switch sp.ceil {
	case ceilSubset:
		return fmt.Sprintf("allows %v", orgVal)
	case ceilFalse, ceilTrue:
		return fmt.Sprintf("sets %v", orgVal)
	}
	return fmt.Sprintf("caps it at %v", orgVal)
}
