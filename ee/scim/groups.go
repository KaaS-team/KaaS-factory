//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package scim

import (
	"encoding/json"
	"net/http"
	"strings"
)

type member struct {
	Value string `json:"value"`
}

func groupView(g Group) map[string]any {
	ms := make([]map[string]any, 0, len(g.Members))
	for _, id := range g.Members {
		ms = append(ms, map[string]any{"value": id, "$ref": usersPath + "/" + id})
	}
	return map[string]any{
		"schemas":     []string{schemaGroup},
		"id":          g.ID,
		"displayName": g.DisplayName,
		"members":     ms,
		"meta":        map[string]any{"resourceType": "Group", "location": groupsPath + "/" + g.ID},
	}
}

func (h *handler) listGroups(w http.ResponseWriter, r *http.Request) {
	name, _, ok := filterValue(r, "displayName")
	if !ok {
		fail(w, 400, "invalidFilter", `only the filter displayName eq "<value>" is supported`)
		return
	}
	groups, err := h.store.ListGroups(name)
	if err != nil {
		storeFail(w, err, "group")
		return
	}
	out := make([]any, 0, len(groups))
	for _, g := range groups {
		out = append(out, groupView(g))
	}
	write(w, 200, listResponse(out))
}

func (h *handler) getGroup(w http.ResponseWriter, _ *http.Request, id string) {
	g, err := h.store.GetGroup(id)
	if err != nil {
		storeFail(w, err, "group")
		return
	}
	write(w, 200, groupView(g))
}

// known reports whether every id names a stored user.
func (h *handler) known(ids []string) bool {
	for _, id := range ids {
		if _, err := h.store.GetUser(id); err != nil {
			return false
		}
	}
	return true
}

func ids(ms []member) []string {
	out := []string{}
	for _, m := range ms {
		out = append(out, m.Value)
	}
	return out
}

func (h *handler) createGroup(w http.ResponseWriter, r *http.Request) {
	var b struct {
		DisplayName string   `json:"displayName"`
		Members     []member `json:"members"`
	}
	if !decodeBody(r, &b) || strings.TrimSpace(b.DisplayName) == "" {
		fail(w, 400, "invalidValue", "displayName is required")
		return
	}
	g := Group{ID: newID(), DisplayName: strings.TrimSpace(b.DisplayName), Members: ids(b.Members)}
	if !h.known(g.Members) {
		fail(w, 400, "invalidValue", "a member is not a known user")
		return
	}
	if err := h.store.CreateGroup(g); err != nil {
		storeFail(w, err, "group")
		return
	}
	write(w, 201, groupView(g))
}

// patchGroup supports add, remove and replace of members, the operations Okta and Entra send.
func (h *handler) patchGroup(w http.ResponseWriter, r *http.Request, id string) {
	g, err := h.store.GetGroup(id)
	if err != nil {
		storeFail(w, err, "group")
		return
	}
	b, ok := readPatch(w, r)
	if !ok {
		return
	}
	for _, op := range b.Operations {
		var vals []member
		_ = json.Unmarshal(op.Value, &vals)
		got := ids(vals)
		if !strings.EqualFold(op.Path, "members") || (!h.known(got)) {
			fail(w, 400, "invalidValue", "only members can be patched, with known users")
			return
		}
		switch strings.ToLower(op.Op) {
		case "add":
			for _, m := range got {
				g.Members = append(without(g.Members, m), m)
			}
		case "remove":
			if len(got) == 0 {
				g.Members = []string{}
			}
			for _, m := range got {
				g.Members = without(g.Members, m)
			}
		case "replace":
			g.Members = got
		default:
			fail(w, 400, "invalidValue", "op "+op.Op+" is not supported")
			return
		}
	}
	if err := h.store.UpdateGroup(g); err != nil {
		storeFail(w, err, "group")
		return
	}
	write(w, 200, groupView(g))
}

func (h *handler) deleteGroup(w http.ResponseWriter, _ *http.Request, id string) {
	if err := h.store.DeleteGroup(id); err != nil {
		storeFail(w, err, "group")
		return
	}
	w.WriteHeader(204)
}
