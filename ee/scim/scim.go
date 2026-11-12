//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

// Package scim serves SCIM 2.0 Users and Groups (RFC 7643, 7644) over a Store, enough for Okta
// and Entra to create, find, deactivate and delete people. The wire shapes follow the TypeScript
// plane in ee/plane/scim.ts.
package scim

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

const (
	schemaUser  = "urn:ietf:params:scim:schemas:core:2.0:User"
	schemaGroup = "urn:ietf:params:scim:schemas:core:2.0:Group"
	schemaList  = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
	schemaError = "urn:ietf:params:scim:api:messages:2.0:Error"
	schemaPatch = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
	mediaType   = "application/scim+json"
	usersPath   = "/scim/v2/Users"
	groupsPath  = "/scim/v2/Groups"
)

// An email can never be a GitHub login, so an IdP user cannot take over a GitHub member.
var emailLike = regexp.MustCompile(`^[^@\s]+@[^@\s]+$`)

// The one filter IdPs send before a create: attr eq "value".
var eqFilter = regexp.MustCompile(`(?i)^(userName|displayName) eq "([^"]*)"$`)

type handler struct {
	store Store
	token string
}

// NewHandler serves /scim/v2/Users and /scim/v2/Groups over store. Every request needs the bearer
// token; an empty token refuses everything.
func NewHandler(store Store, bearerToken string) http.Handler {
	return &handler{store: store, token: bearerToken}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.authed(r) {
		fail(w, 401, "", "a valid SCIM bearer token is required")
		return
	}
	switch {
	case r.URL.Path == usersPath:
		h.collection(w, r, h.listUsers, h.createUser)
	case strings.HasPrefix(r.URL.Path, usersPath+"/"):
		h.item(w, r, strings.TrimPrefix(r.URL.Path, usersPath+"/"), h.getUser, h.patchUser, h.deleteUser)
	case r.URL.Path == groupsPath:
		h.collection(w, r, h.listGroups, h.createGroup)
	case strings.HasPrefix(r.URL.Path, groupsPath+"/"):
		h.item(w, r, strings.TrimPrefix(r.URL.Path, groupsPath+"/"), h.getGroup, h.patchGroup, h.deleteGroup)
	default:
		fail(w, 404, "", "no such resource")
	}
}

func (h *handler) authed(r *http.Request) bool {
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return h.token != "" && ok && subtle.ConstantTimeCompare([]byte(got), []byte(h.token)) == 1
}

type (
	listFn   func(http.ResponseWriter, *http.Request)
	createFn func(http.ResponseWriter, *http.Request)
	itemFn   func(http.ResponseWriter, *http.Request, string)
)

func (h *handler) collection(w http.ResponseWriter, r *http.Request, list listFn, create createFn) {
	switch r.Method {
	case http.MethodGet:
		list(w, r)
	case http.MethodPost:
		create(w, r)
	default:
		fail(w, 405, "", "method not allowed")
	}
}

func (h *handler) item(w http.ResponseWriter, r *http.Request, id string, get, patch, del itemFn) {
	switch r.Method {
	case http.MethodGet:
		get(w, r, id)
	case http.MethodPatch:
		patch(w, r, id)
	case http.MethodDelete:
		del(w, r, id)
	default:
		fail(w, 405, "", "method not allowed")
	}
}

func write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", mediaType)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, scimType, detail string) {
	body := map[string]any{"schemas": []string{schemaError}, "status": fmt.Sprint(status), "detail": detail}
	if scimType != "" {
		body["scimType"] = scimType
	}
	write(w, status, body)
}

// storeFail maps a Store error to a SCIM error response.
func storeFail(w http.ResponseWriter, err error, what string) {
	switch {
	case errors.Is(err, ErrNotFound):
		fail(w, 404, "", "no such "+what)
	case errors.Is(err, ErrConflict):
		fail(w, 409, "uniqueness", what+" name is taken")
	default:
		fail(w, 500, "", "the store failed")
	}
}

func decodeBody(r *http.Request, v any) bool {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(v) == nil
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// filterValue returns the value of an `attr eq "x"` filter, whether one was given, and whether
// it is one we support.
func filterValue(r *http.Request, attr string) (val string, given, ok bool) {
	f := r.URL.Query().Get("filter")
	if f == "" {
		return "", false, true
	}
	m := eqFilter.FindStringSubmatch(f)
	if m == nil || !strings.EqualFold(m[1], attr) {
		return "", true, false
	}
	return m[2], true, true
}

func listResponse(resources []any) map[string]any {
	if resources == nil {
		resources = []any{}
	}
	return map[string]any{"schemas": []string{schemaList}, "totalResults": len(resources), "itemsPerPage": len(resources), "startIndex": 1, "Resources": resources}
}

type patchOp struct {
	Op    string          `json:"op"`
	Path  string          `json:"path"`
	Value json.RawMessage `json:"value"`
}

type patchBody struct {
	Schemas    []string  `json:"schemas"`
	Operations []patchOp `json:"Operations"`
}

func readPatch(w http.ResponseWriter, r *http.Request) (patchBody, bool) {
	var b patchBody
	if !decodeBody(r, &b) {
		fail(w, 400, "invalidSyntax", "the body is not JSON")
		return b, false
	}
	for _, s := range b.Schemas {
		if s == schemaPatch {
			return b, true
		}
	}
	fail(w, 400, "invalidSyntax", "expected a PatchOp")
	return b, false
}
