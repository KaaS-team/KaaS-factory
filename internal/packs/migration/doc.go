// Package migration loads declarative migration packs and decides which files each step sees.
//
// A pack is one YAML file. The design follows OpenRewrite's declarative recipes (an ordered recipe
// list with preconditions); the code is written for this repository. Unknown fields are errors.
//
// Pack schema:
//
//	type: specs.factory/migration     # required, exactly this value
//	name: example.react.Bump18        # required, dotted identifier
//	displayName: Bump react to 18     # optional
//	description: text                 # required
//	tags: [react]                     # optional
//	preconditions: [predicate, ...]   # optional, gate every step (all must hold)
//	steps:                            # required, run in order
//	  - name: bump                    # required, unique among siblings
//	    files: [predicate, ...]       # optional, a file is seen only if all hold
//	    run: [argv, ...]              # one of run, prompt, steps
//	    prompt: text                  # a model prompt, the matched files are listed to it
//	    steps: [step, ...]            # nested steps, each inherits the parent's files
//
// A run argument equal to {files} expands to the matched files. A predicate is a map with exactly
// one key:
//
//	and: [predicate, ...]   or: [predicate, ...]   not: predicate
//	glob: "src/**/*.tsx"    # path glob, ** crosses directories
//	contains: 'regex'       # the file content matches the regex
//	dependency:             # the manifest (package.json or go.mod) lists a dependency
//	  name: react
//	  manifest: package.json   # optional, default: either manifest
//	  version: ">=17 <18"      # optional range of comparators joined by spaces
//
// A pack is pinned in factory.lock as a workflow entry, and Verify checks the file against it.
package migration
