// Ported from Aider-AI/aider@5dc9490 aider/repomap.py

package repomap

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

// ParseTimeout bounds the parse of one file.
const ParseTimeout = 2 * time.Second

// Options selects the files and seeds of one map. Paths are relative to Root.
type Options struct {
	Root            string
	Chat            []string // files already in the conversation: seeded high, kept out of the map
	Others          []string // candidate files for the map
	MentionedFiles  map[string]bool
	MentionedIdents map[string]bool
	Budget          int              // token budget for Build
	Tokens          func(string) int // token estimator; EstimateTokens when nil
	Cache           *Cache           // optional mtime-keyed tag cache
}

type edge struct {
	src, dst string
	w        float64
	ident    string
}

func isLetter(s string) bool { return strings.IndexFunc(s, unicode.IsLetter) >= 0 }

// identWeight is the multiplier repomap.py gives an identifier's edges.
func identWeight(ident string, mentioned bool, definers int) float64 {
	mul := 1.0
	snake := strings.Contains(ident, "_") && isLetter(ident)
	kebab := strings.Contains(ident, "-") && isLetter(ident)
	camel := strings.IndexFunc(ident, unicode.IsUpper) >= 0 && strings.IndexFunc(ident, unicode.IsLower) >= 0
	if mentioned {
		mul *= 10
	}
	if (snake || kebab || camel) && len(ident) >= 8 {
		mul *= 10
	}
	if strings.HasPrefix(ident, "_") {
		mul *= 0.1
	}
	if definers > 5 {
		mul *= 0.1
	}
	return mul
}

func tagsOf(ctx context.Context, o Options, rel string) ([]Tag, bool) {
	st, err := os.Stat(filepath.Join(o.Root, rel))
	if err != nil || !st.Mode().IsRegular() {
		return nil, false
	}
	if o.Cache != nil {
		if t, ok := o.Cache.get(rel, st.ModTime(), st.Size()); ok {
			return t, true
		}
	}
	if st.Size() > MaxFileBytes {
		return nil, true
	}
	src, err := os.ReadFile(filepath.Join(o.Root, rel))
	if err != nil {
		return nil, false
	}
	pctx, cancel := context.WithTimeout(ctx, ParseTimeout)
	defer cancel()
	tags, err := ParseFile(pctx, rel, src)
	if err != nil {
		return nil, true
	}
	if o.Cache != nil {
		o.Cache.put(rel, st.ModTime(), st.Size(), tags)
	}
	return tags, true
}

// Rank returns the definition tags of the Chat and Others files, most important first, using
// personalised PageRank over the reference graph with the weights of repomap.py. Files without
// definitions follow as tags with an empty Name.
func Rank(ctx context.Context, o Options) ([]Tag, error) {
	set := map[string]bool{}
	for _, f := range append(append([]string{}, o.Chat...), o.Others...) {
		set[f] = true
	}
	fnames := make([]string, 0, len(set))
	for f := range set {
		fnames = append(fnames, f)
	}
	sort.Strings(fnames)
	if len(fnames) == 0 {
		return nil, nil
	}
	chat := map[string]bool{}
	for _, f := range o.Chat {
		chat[f] = true
	}
	personalize := 100 / float64(len(fnames))
	pers := map[string]float64{}
	defines := map[string]map[string]bool{}
	refs := map[string][]string{}
	defs := map[[2]string][]Tag{}
	for _, f := range fnames {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		tags, ok := tagsOf(ctx, o, f)
		if !ok {
			continue
		}
		cur := 0.0
		if chat[f] {
			cur += personalize
		}
		if o.MentionedFiles[f] {
			cur = math.Max(cur, personalize)
		}
		if matchesIdent(f, o.MentionedIdents) {
			cur += personalize
		}
		if cur > 0 {
			pers[f] = cur
		}
		for _, t := range tags {
			if t.Kind == "def" {
				if defines[t.Name] == nil {
					defines[t.Name] = map[string]bool{}
				}
				defines[t.Name][f] = true
				defs[[2]string{f, t.Name}] = append(defs[[2]string{f, t.Name}], t)
			} else {
				refs[t.Name] = append(refs[t.Name], f)
			}
		}
	}
	if len(refs) == 0 {
		for k, v := range defines {
			for f := range v {
				refs[k] = append(refs[k], f)
			}
		}
	}
	var edges []edge
	idents := make([]string, 0, len(defines))
	for id := range defines {
		idents = append(idents, id)
	}
	sort.Strings(idents)
	for _, id := range idents {
		definers := sortedKeys(defines[id])
		if _, ok := refs[id]; !ok {
			for _, d := range definers {
				edges = append(edges, edge{d, d, 0.1, id})
			}
			continue
		}
		mul := identWeight(id, o.MentionedIdents[id], len(definers))
		count := map[string]int{}
		for _, r := range refs[id] {
			count[r]++
		}
		for _, r := range sortedKeys(count) {
			use := mul
			if chat[r] {
				use *= 50
			}
			n := math.Sqrt(float64(count[r]))
			for _, d := range definers {
				edges = append(edges, edge{r, d, use * n, id})
			}
		}
	}
	ranked := pageRank(edges, pers)

	outW := map[string]float64{}
	for _, e := range edges {
		outW[e.src] += e.w
	}
	type fi struct{ file, ident string }
	score := map[fi]float64{}
	for _, e := range edges {
		score[fi{e.dst, e.ident}] += ranked[e.src] * e.w / outW[e.src]
	}
	keys := make([]fi, 0, len(score))
	for k := range score {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if score[keys[i]] != score[keys[j]] {
			return score[keys[i]] > score[keys[j]]
		}
		if keys[i].file != keys[j].file {
			return keys[i].file > keys[j].file
		}
		return keys[i].ident > keys[j].ident
	})
	var out []Tag
	included := map[string]bool{}
	for _, k := range keys {
		if chat[k.file] {
			continue
		}
		out = append(out, defs[[2]string{k.file, k.ident}]...)
		included[k.file] = true
	}
	rest := map[string]bool{}
	for _, f := range o.Others {
		rest[f] = true
	}
	nodes := make([]string, 0, len(ranked))
	for n := range ranked {
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool {
		if ranked[nodes[i]] != ranked[nodes[j]] {
			return ranked[nodes[i]] > ranked[nodes[j]]
		}
		return nodes[i] > nodes[j]
	})
	for _, n := range nodes {
		delete(rest, n)
		if !included[n] && !chat[n] {
			out = append(out, Tag{File: n})
			included[n] = true
		}
	}
	for _, f := range sortedKeys(rest) {
		if !included[f] {
			out = append(out, Tag{File: f})
		}
	}
	return out, nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

var splitRe = regexp.MustCompile(`[/\\]`)

// matchesIdent reports whether a path component, the base name or the base name without extension is a mentioned ident.
func matchesIdent(rel string, idents map[string]bool) bool {
	if len(idents) == 0 {
		return false
	}
	base := filepath.Base(rel)
	for _, c := range append(splitRe.Split(rel, -1), base, strings.TrimSuffix(base, filepath.Ext(base))) {
		if idents[c] {
			return true
		}
	}
	return false
}

// pageRank is power iteration with damping 0.85 over the weighted multigraph. The personalization,
// when given, is both the teleport and the dangling distribution, as in the networkx call of repomap.py.
func pageRank(edges []edge, pers map[string]float64) map[string]float64 {
	nodes := map[string]bool{}
	out := map[string]float64{}
	for _, e := range edges {
		nodes[e.src], nodes[e.dst] = true, true
		out[e.src] += e.w
	}
	for n := range pers {
		nodes[n] = true
	}
	list := sortedKeys(nodes)
	n := float64(len(list))
	if n == 0 {
		return map[string]float64{}
	}
	p := map[string]float64{}
	var psum float64
	for _, v := range pers {
		psum += v
	}
	for _, k := range list {
		if psum > 0 {
			p[k] = pers[k] / psum
		} else {
			p[k] = 1 / n
		}
	}
	x := map[string]float64{}
	for _, k := range list {
		x[k] = 1 / n
	}
	const alpha, tol = 0.85, 1e-6
	for iter := 0; iter < 100; iter++ {
		next := map[string]float64{}
		var dangling float64
		for _, k := range list {
			if out[k] == 0 {
				dangling += x[k]
			}
		}
		for _, e := range edges {
			next[e.dst] += alpha * x[e.src] * e.w / out[e.src]
		}
		var diff float64
		for _, k := range list {
			next[k] += alpha*dangling*p[k] + (1-alpha)*p[k]
			diff += math.Abs(next[k] - x[k])
		}
		x = next
		if diff < n*tol {
			break
		}
	}
	return x
}

var wordRe = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]{2,}`)

// Mentions finds which of known files and which identifiers a ticket text names. A file counts when
// its path or base name appears in the text; an identifier is any word of three or more characters.
func Mentions(text string, known []string) (files, idents map[string]bool) {
	files, idents = map[string]bool{}, map[string]bool{}
	for _, f := range known {
		if strings.Contains(text, f) {
			files[f] = true
		}
	}
	for _, w := range wordRe.FindAllString(text, -1) {
		idents[w] = true
	}
	return files, idents
}
