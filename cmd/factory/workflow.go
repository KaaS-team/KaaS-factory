package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/internal/core"
	"github.com/KaaS-team/factory/internal/graph"
	"github.com/KaaS-team/factory/internal/graph/checkpoint"
	"github.com/KaaS-team/factory/internal/tutor"
)

// Tier names the tutor policy and a workflow's `tier:` keys use. config `models.<tier>` maps each to a model.
const (
	studentTier = "small"
	teacherTier = "large"
)

// workflowGraph loads the workflow a ticket runs from the repo at root: the default for "", else the
// file .factory/workflows/<name>.yml, .yaml or .md. A file that does not load is an error naming it,
// and so is a node the run loop cannot run: it runs agent nodes only.
func workflowGraph(root, name string) (*graph.Graph, error) {
	g, err := loadWorkflow(root, name)
	if err != nil {
		return nil, err
	}
	for _, n := range g.Nodes() {
		if n.Kind != graph.KindAgent {
			return nil, fmt.Errorf("workflow %s: node %s is a %s node; factory run runs agent nodes only", g.Name, n.ID, n.Kind)
		}
	}
	return g, nil
}

func loadWorkflow(root, name string) (*graph.Graph, error) {
	if name == "" {
		return graph.LoadDefault(root)
	}
	name = filepath.Base(name)
	p := graph.WorkflowFile(root, name)
	if p == "" {
		return nil, fmt.Errorf("workflow %q: no file .factory/workflows/%s.yml, .yaml or .md", name, name)
	}
	g, err := graph.Load(p)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	return g, nil
}

// stagesFor is how the run loop walks workflows in the working directory. The tutor picks tiers only when
// config names a model for both tiers; a node that pins a tier gets it either way.
func stagesFor(cfg config.Config) (*core.Stages, error) {
	cp, err := openCheckpoints()
	if err != nil {
		return nil, err
	}
	s := &core.Stages{Graph: func(name string) (*graph.Graph, error) { return workflowGraph(".", name) }, Checkpoints: cp}
	if cfg.Models[studentTier] != "" && cfg.Models[teacherTier] != "" {
		s.Policy = tutor.Policy{Student: studentTier, Teacher: teacherTier, MaxStudentAttempts: 2, TeacherVerifies: true}
	}
	return s, nil
}

// openCheckpoints opens the file that holds each ticket's place in its workflow, so a restart
// resumes at the node it had reached instead of the first one.
func openCheckpoints() (*checkpoint.Store, error) {
	if err := os.MkdirAll(filepath.Dir(checkpointPath), 0o755); err != nil {
		return nil, err
	}
	return checkpoint.Open(checkpointPath)
}
