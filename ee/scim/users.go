//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package scim

import (
	"encoding/json"
	"net/http"
	"strings"
)

func userView(u User) map[string]any {
	v := map[string]any{
		"schemas":  []string{schemaUser},
		"id":       u.ID,
		"userName": u.UserName,
		"active":   u.Active,
		"emails":   []map[string]any{{"value": u.UserName, "primary": true}},
		"meta":     map[string]any{"resourceType": "User", "location": usersPath + "/" + u.ID},
	}
	if u.ExternalID != "" {
		v["externalId"] = u.ExternalID
	}
	return v
}

func (h *handler) listUsers(w http.ResponseWriter, r *http.Request) {
	name, _, ok := filterValue(r, "userName")
	if !ok {
		fail(w, 400, "invalidFilter", `only the filter userName eq "<value>" is supported`)
		return
	}
	users, err := h.store.ListUsers(strings.ToLower(name))
	if err != nil {
		storeFail(w, err, "user")
		return
	}
	out := make([]any, 0, len(users))
	for _, u := range users {
		out = append(out, userView(u))
	}
	write(w, 200, listResponse(out))
}

func (h *handler) getUser(w http.ResponseWriter, _ *http.Request, id string) {
	u, err := h.store.GetUser(id)
	if err != nil {
		storeFail(w, err, "user")
		return
	}
	write(w, 200, userView(u))
}

func (h *handler) createUser(w http.ResponseWriter, r *http.Request) {
	var b struct {
		UserName   string `json:"userName"`
		ExternalID string `json:"externalId"`
		Active     *bool  `json:"active"`
	}
	if !decodeBody(r, &b) {
		fail(w, 400, "invalidSyntax", "the body is not JSON")
		return
	}
	name := strings.ToLower(strings.TrimSpace(b.UserName))
	if !emailLike.MatchString(name) {
		fail(w, 400, "invalidValue", "userName must be an email address")
		return
	}
	u := User{ID: newID(), UserName: name, ExternalID: b.ExternalID, Active: b.Active == nil || *b.Active}
	if err := h.store.CreateUser(u); err != nil {
		storeFail(w, err, "user")
		return
	}
	write(w, 201, userView(u))
}

// patchUser supports `replace` of active, as a value object or as path "active".
func (h *handler) patchUser(w http.ResponseWriter, r *http.Request, id string) {
	u, err := h.store.GetUser(id)
	if err != nil {
		storeFail(w, err, "user")
		return
	}
	b, ok := readPatch(w, r)
	if !ok {
		return
	}
	for _, op := range b.Operations {
		if !strings.EqualFold(op.Op, "replace") {
			fail(w, 400, "invalidValue", "op "+op.Op+" is not supported")
			return
		}
		if active, found := activeOf(op); found {
			u.Active = active
		}
	}
	if err := h.store.UpdateUser(u); err != nil {
		storeFail(w, err, "user")
		return
	}
	write(w, 200, userView(u))
}

func activeOf(op patchOp) (active, found bool) {
	if op.Path != "" {
		if !strings.EqualFold(op.Path, "active") {
			return false, false
		}
		return boolOf(op.Value)
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(op.Value, &obj) != nil {
		return false, false
	}
	for k, v := range obj {
		if strings.EqualFold(k, "active") {
			return boolOf(v)
		}
	}
	return false, false
}

func boolOf(raw json.RawMessage) (val, ok bool) {
	// Entra sends the strings "True" and "False".
	var s string
	if json.Unmarshal(raw, &s) == nil {
		switch strings.ToLower(s) {
		case "true":
			return true, true
		case "false":
			return false, true
		}
		return false, false
	}
	return val, json.Unmarshal(raw, &val) == nil
}

// deleteUser also drops the user from every group, so no group lists a person who is gone.
func (h *handler) deleteUser(w http.ResponseWriter, _ *http.Request, id string) {
	if err := h.store.DeleteUser(id); err != nil {
		storeFail(w, err, "user")
		return
	}
	groups, err := h.store.ListGroups("")
	if err != nil {
		storeFail(w, err, "group")
		return
	}
	for _, g := range groups {
		kept := without(g.Members, id)
		if len(kept) != len(g.Members) {
			g.Members = kept
			if err := h.store.UpdateGroup(g); err != nil {
				storeFail(w, err, "group")
				return
			}
		}
	}
	w.WriteHeader(204)
}

func without(list []string, id string) []string {
	out := []string{}
	for _, s := range list {
		if s != id {
			out = append(out, s)
		}
	}
	return out
}
