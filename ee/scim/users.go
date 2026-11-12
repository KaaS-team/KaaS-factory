//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package scim

import (
	"net/http"
	"regexp"
	"strings"

	lib "github.com/elimity-com/scim"
	scimerr "github.com/elimity-com/scim/errors"
)

// An email can never be a GitHub login, so an IdP user cannot take over a GitHub member.
var emailLike = regexp.MustCompile(`^[^@\s]+@[^@\s]+$`)

type userHandler struct{ store Store }

func userResource(u User) lib.Resource {
	return lib.Resource{ID: u.ID, ExternalID: externalID(lib.ResourceAttributes{"externalId": u.ExternalID}), Attributes: lib.ResourceAttributes{
		"userName": u.UserName,
		"active":   u.Active,
		"emails":   []any{map[string]any{"value": u.UserName, "primary": true}},
	}}
}

// own returns the user when it belongs to the request's tenant; another tenant's id is not found.
func (h userHandler) own(r *http.Request, id string) (User, error) {
	u, err := h.store.GetUser(id)
	if err == nil && u.Tenant != tenantFrom(r) {
		err = ErrNotFound
	}
	return u, storeErr(err, id)
}

// fill sets the fields a Create or Replace body carries; the userName must be an email address.
func fill(u User, a lib.ResourceAttributes) (User, error) {
	name, _ := a["userName"].(string)
	name = strings.ToLower(strings.TrimSpace(name))
	if !emailLike.MatchString(name) {
		return u, scimerr.ScimErrorBadRequest("userName must be an email address")
	}
	u.UserName, u.ExternalID, u.Active = name, externalID(a).Value(), true
	if active, ok := a["active"].(bool); ok {
		u.Active = active
	}
	return u, nil
}

func (h userHandler) Create(r *http.Request, a lib.ResourceAttributes) (lib.Resource, error) {
	u, err := fill(User{ID: newID(), Tenant: tenantFrom(r)}, a)
	if err != nil {
		return lib.Resource{}, err
	}
	if err := h.store.CreateUser(u); err != nil {
		return lib.Resource{}, storeErr(err, "")
	}
	return userResource(u), nil
}

func (h userHandler) Get(r *http.Request, id string) (lib.Resource, error) {
	u, err := h.own(r, id)
	return userResource(u), err
}

func (h userHandler) GetAll(r *http.Request, p lib.ListRequestParams) (lib.Page, error) {
	users, err := h.store.ListUsers(tenantFrom(r))
	if err != nil {
		return lib.Page{}, storeErr(err, "")
	}
	all := make([]lib.Resource, 0, len(users))
	for _, u := range users {
		all = append(all, userResource(u))
	}
	return page(all, withIdentity, p), nil
}

func (h userHandler) Replace(r *http.Request, id string, a lib.ResourceAttributes) (lib.Resource, error) {
	u, err := h.own(r, id)
	if err != nil {
		return lib.Resource{}, err
	}
	if u, err = fill(u, a); err != nil {
		return lib.Resource{}, err
	}
	if err := h.store.UpdateUser(u); err != nil {
		return lib.Resource{}, storeErr(err, id)
	}
	return userResource(u), nil
}

// Delete also drops the user from every group of the tenant, so no group lists a person who is gone.
func (h userHandler) Delete(r *http.Request, id string) error {
	if _, err := h.own(r, id); err != nil {
		return err
	}
	if err := h.store.DeleteUser(id); err != nil {
		return storeErr(err, id)
	}
	groups, err := h.store.ListGroups(tenantFrom(r))
	if err != nil {
		return storeErr(err, "")
	}
	for _, g := range groups {
		if kept := without(g.Members, id); len(kept) != len(g.Members) {
			g.Members = kept
			if err := h.store.UpdateGroup(g); err != nil {
				return storeErr(err, g.ID)
			}
		}
	}
	return nil
}

// Patch supports replace of active, as a value object or as path "active". Entra sends the
// strings "True" and "False" for the boolean.
func (h userHandler) Patch(r *http.Request, id string, ops []lib.PatchOperation) (lib.Resource, error) {
	u, err := h.own(r, id)
	if err != nil {
		return lib.Resource{}, err
	}
	for _, op := range ops {
		if !strings.EqualFold(op.Op, lib.PatchOperationReplace) {
			return lib.Resource{}, scimerr.ScimErrorBadRequest("op " + op.Op + " is not supported")
		}
		v := op.Value
		if obj, ok := v.(map[string]any); ok && patchTarget(op) == "" {
			v = obj["active"]
		} else if patchTarget(op) != "active" {
			continue
		}
		if active, ok := boolOf(v); ok {
			u.Active = active
		}
	}
	if err := h.store.UpdateUser(u); err != nil {
		return lib.Resource{}, storeErr(err, id)
	}
	return userResource(u), nil
}

func boolOf(v any) (val, ok bool) {
	switch x := v.(type) {
	case bool:
		return x, true
	case string:
		switch strings.ToLower(x) {
		case "true":
			return true, true
		case "false":
			return false, true
		}
	}
	return false, false
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
