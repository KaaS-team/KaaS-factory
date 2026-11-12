//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package scim

import (
	"net/http"
	"strings"

	lib "github.com/elimity-com/scim"
	scimerr "github.com/elimity-com/scim/errors"
	filter "github.com/scim2/filter-parser/v2"
)

type groupHandler struct{ store Store }

func groupResource(g Group) lib.Resource {
	ms := make([]any, 0, len(g.Members))
	for _, id := range g.Members {
		ms = append(ms, map[string]any{"value": id, "$ref": basePath + "/Users/" + id})
	}
	return lib.Resource{ID: g.ID, Attributes: lib.ResourceAttributes{"displayName": g.DisplayName, "members": ms}}
}

// own returns the group when it belongs to the request's tenant; another tenant's id is not found.
func (h groupHandler) own(r *http.Request, id string) (Group, error) {
	g, err := h.store.GetGroup(id)
	if err == nil && g.Tenant != tenantFrom(r) {
		err = ErrNotFound
	}
	return g, storeErr(err, id)
}

// known reports whether every id names a user of the tenant.
func (h groupHandler) known(r *http.Request, ids []string) bool {
	for _, id := range ids {
		if u, err := h.store.GetUser(id); err != nil || u.Tenant != tenantFrom(r) {
			return false
		}
	}
	return true
}

// memberIDs reads the value of each member in a SCIM members array.
func memberIDs(v any) []string {
	out := []string{}
	list, _ := v.([]any)
	for _, m := range list {
		if obj, ok := m.(map[string]any); ok {
			if s, ok := obj["value"].(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

func (h groupHandler) Create(r *http.Request, a lib.ResourceAttributes) (lib.Resource, error) {
	name, _ := a["displayName"].(string)
	g := Group{ID: newID(), Tenant: tenantFrom(r), DisplayName: strings.TrimSpace(name), Members: memberIDs(a["members"])}
	if g.DisplayName == "" || !h.known(r, g.Members) {
		return lib.Resource{}, scimerr.ScimErrorBadRequest("displayName is required and members must be known users")
	}
	if err := h.store.CreateGroup(g); err != nil {
		return lib.Resource{}, storeErr(err, "")
	}
	return groupResource(g), nil
}

func (h groupHandler) Get(r *http.Request, id string) (lib.Resource, error) {
	g, err := h.own(r, id)
	return groupResource(g), err
}

func (h groupHandler) GetAll(r *http.Request, p lib.ListRequestParams) (lib.Page, error) {
	groups, err := h.store.ListGroups(tenantFrom(r))
	if err != nil {
		return lib.Page{}, storeErr(err, "")
	}
	all := make([]lib.Resource, 0, len(groups))
	for _, g := range groups {
		all = append(all, groupResource(g))
	}
	return page(all, withIdentity, p), nil
}

func (h groupHandler) Replace(r *http.Request, id string, a lib.ResourceAttributes) (lib.Resource, error) {
	g, err := h.own(r, id)
	if err != nil {
		return lib.Resource{}, err
	}
	name, _ := a["displayName"].(string)
	g.DisplayName, g.Members = strings.TrimSpace(name), memberIDs(a["members"])
	if g.DisplayName == "" || !h.known(r, g.Members) {
		return lib.Resource{}, scimerr.ScimErrorBadRequest("displayName is required and members must be known users")
	}
	if err := h.store.UpdateGroup(g); err != nil {
		return lib.Resource{}, storeErr(err, id)
	}
	return groupResource(g), nil
}

func (h groupHandler) Delete(r *http.Request, id string) error {
	if _, err := h.own(r, id); err != nil {
		return err
	}
	return storeErr(h.store.DeleteGroup(id), id)
}

// Patch supports add, remove and replace of members, and replace of displayName, the operations
// Okta and Entra send. A remove may name one member as members[value eq "id"].
func (h groupHandler) Patch(r *http.Request, id string, ops []lib.PatchOperation) (lib.Resource, error) {
	g, err := h.own(r, id)
	if err != nil {
		return lib.Resource{}, err
	}
	for _, op := range ops {
		switch target := patchTarget(op); {
		case target == "displayName" && strings.EqualFold(op.Op, lib.PatchOperationReplace):
			name, _ := op.Value.(string)
			g.DisplayName = strings.TrimSpace(name)
		case target == "members":
			got := memberIDs(op.Value)
			if sel := selected(op); sel != "" {
				got = []string{sel}
			}
			if !h.known(r, got) {
				return lib.Resource{}, scimerr.ScimErrorBadRequest("members must be known users")
			}
			switch strings.ToLower(op.Op) {
			case lib.PatchOperationAdd:
				for _, m := range got {
					g.Members = append(without(g.Members, m), m)
				}
			case lib.PatchOperationRemove:
				if len(got) == 0 {
					g.Members = []string{}
				}
				for _, m := range got {
					g.Members = without(g.Members, m)
				}
			default:
				g.Members = got
			}
		default:
			return lib.Resource{}, scimerr.ScimErrorBadRequest("only members and displayName can be patched")
		}
	}
	if err := h.store.UpdateGroup(g); err != nil {
		return lib.Resource{}, storeErr(err, id)
	}
	return groupResource(g), nil
}

// selected returns the id in a members[value eq "id"] path, or "".
func selected(op lib.PatchOperation) string {
	if op.Path == nil {
		return ""
	}
	if e, ok := op.Path.ValueExpression.(*filter.AttributeExpression); ok && e.AttributePath.AttributeName == "value" {
		s, _ := e.CompareValue.(string)
		return s
	}
	return ""
}
