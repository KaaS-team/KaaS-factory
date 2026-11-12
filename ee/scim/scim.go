//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

// Package scim serves SCIM 2.0 Users and Groups (RFC 7643, 7644) over a Store, enough for Okta
// and Entra to create, find, deactivate and delete people. The protocol, schemas, filters and
// PATCH parsing come from github.com/elimity-com/scim; this package adds the bearer-token
// tenant check, the audit event per call and the Store-backed resource handlers.
package scim

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	lib "github.com/elimity-com/scim"
	scimerr "github.com/elimity-com/scim/errors"
	"github.com/elimity-com/scim/optional"
	"github.com/elimity-com/scim/schema"
)

const (
	basePath  = "/scim/v2"
	mediaType = "application/scim+json"
)

type tenantKey struct{}

// Event is the audit record of one SCIM call. Tenant is empty when the bearer token was refused.
type Event struct {
	Tenant string `json:"tenant"`
	Method string `json:"method"`
	Path   string `json:"path"`
	Status int    `json:"status"`
}

type handler struct {
	srv    lib.Server
	tokens map[string]string
	audit  func(Event)
}

// NewHandler serves /scim/v2 over store for one tenant, "default", behind one bearer token. Every
// call is written to stderr as a JSON audit line. An empty token refuses everything.
func NewHandler(store Store, bearerToken string) http.Handler {
	tokens := map[string]string{}
	if bearerToken != "" {
		tokens[bearerToken] = "default"
	}
	enc := json.NewEncoder(os.Stderr)
	return NewTenantHandler(store, tokens, func(e Event) { _ = enc.Encode(e) })
}

// NewTenantHandler serves /scim/v2 over store. tokens maps each accepted bearer token to the
// tenant it may read and write; audit receives one Event per call, refused calls included.
func NewTenantHandler(store Store, tokens map[string]string, audit func(Event)) http.Handler {
	cfg := &lib.ServiceProviderConfig{
		AuthenticationSchemes: []lib.AuthenticationScheme{{
			Type: lib.AuthenticationTypeOauthBearerToken, Name: "Bearer token", Description: "A static bearer token per tenant", Primary: true,
		}},
		MaxResults: 100, SupportFiltering: true, SupportPatch: true,
	}
	srv, err := lib.NewServer(&lib.ServerArgs{ServiceProviderConfig: cfg, ResourceTypes: []lib.ResourceType{
		{ID: optional.NewString("User"), Name: "User", Endpoint: "/Users", Schema: schema.CoreUserSchema(), Handler: userHandler{store}},
		{ID: optional.NewString("Group"), Name: "Group", Endpoint: "/Groups", Schema: schema.CoreGroupSchema(), Handler: groupHandler{store}},
	}}, lib.WithBaseURL(basePath))
	if err != nil {
		panic("scim: built-in schemas rejected: " + err.Error())
	}
	return &handler{srv: srv, tokens: tokens, audit: audit}
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) { w.status = code; w.ResponseWriter.WriteHeader(code) }

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
	tenant, ok := h.tenantOf(r)
	rest, underBase := strings.CutPrefix(r.URL.Path, "/scim")
	switch {
	case !ok:
		sw.Header().Set("Content-Type", mediaType)
		sw.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(sw).Encode(scimerr.ScimError{Status: 401, Detail: "a valid SCIM bearer token is required"})
	case !underBase || !strings.HasPrefix(rest, "/v2"):
		sw.Header().Set("Content-Type", mediaType)
		sw.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(sw).Encode(scimerr.ScimError{Status: 404, Detail: "no such resource"})
	default:
		r2 := r.Clone(context.WithValue(r.Context(), tenantKey{}, tenant))
		r2.URL.Path = rest
		if r.Method == http.MethodPatch {
			entraBools(r2)
		}
		h.srv.ServeHTTP(sw, r2)
	}
	if h.audit != nil {
		h.audit(Event{Tenant: map[bool]string{true: tenant}[ok], Method: r.Method, Path: r.URL.Path, Status: sw.status})
	}
}

// tenantOf compares the bearer token against every configured token, so timing does not reveal
// which one matched.
func (h *handler) tenantOf(r *http.Request) (tenant string, ok bool) {
	got, has := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !has || got == "" {
		return "", false
	}
	for tok, t := range h.tokens {
		if subtle.ConstantTimeCompare([]byte(got), []byte(tok)) == 1 {
			tenant, ok = t, true
		}
	}
	return tenant, ok
}

func tenantFrom(r *http.Request) string { t, _ := r.Context().Value(tenantKey{}).(string); return t }

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// storeErr maps a Store error to a SCIM error the library renders.
func storeErr(err error, id string) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNotFound):
		return scimerr.ScimErrorResourceNotFound(id)
	case errors.Is(err, ErrConflict):
		return scimerr.ScimErrorUniqueness
	default:
		return scimerr.ScimErrorInternal
	}
}

// page filters resources with the request's filter, then slices the requested window.
func page(all []lib.Resource, view func(lib.Resource) map[string]any, p lib.ListRequestParams) lib.Page {
	var kept []lib.Resource
	for _, res := range all {
		if p.FilterValidator == nil || p.FilterValidator.PassesFilter(view(res)) == nil {
			kept = append(kept, res)
		}
	}
	from := min(max(p.StartIndex-1, 0), len(kept))
	to := min(from+p.Count, len(kept))
	return lib.Page{TotalResults: len(kept), Resources: kept[from:to]}
}

// withIdentity adds the id and externalId a filter may name to a copy of the attributes.
func withIdentity(r lib.Resource) map[string]any {
	m := map[string]any{"id": r.ID}
	for k, v := range r.Attributes {
		m[k] = v
	}
	if r.ExternalID.Present() {
		m["externalId"] = r.ExternalID.Value()
	}
	return m
}

func externalID(a lib.ResourceAttributes) optional.String {
	if s, ok := a["externalId"].(string); ok && s != "" {
		return optional.NewString(s)
	}
	return optional.String{}
}

// patchTarget names the attribute a PATCH operation addresses, "" for a whole-resource value.
func patchTarget(op lib.PatchOperation) string {
	if op.Path == nil {
		return ""
	}
	return op.Path.AttributePath.AttributeName
}

// entraBools rewrites the strings "True" and "False" Entra sends for active in a PATCH body into
// booleans, which the library's schema check requires. A body that is not JSON passes through.
func entraBools(r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 1<<20))
	r.Body = io.NopCloser(bytes.NewReader(data))
	var body struct {
		Schemas    json.RawMessage  `json:"schemas"`
		Operations []map[string]any `json:"Operations"`
	}
	if err != nil || json.Unmarshal(data, &body) != nil {
		return
	}
	fix := func(m map[string]any, key string) {
		if b, ok := boolOf(m[key]); ok {
			if _, isString := m[key].(string); isString {
				m[key] = b
			}
		}
	}
	for _, op := range body.Operations {
		if p, _ := op["path"].(string); strings.EqualFold(p, "active") {
			fix(op, "value")
		} else if v, ok := op["value"].(map[string]any); ok {
			fix(v, "active")
		}
	}
	out, err := json.Marshal(map[string]any{"schemas": body.Schemas, "Operations": body.Operations})
	if err == nil {
		r.Body = io.NopCloser(bytes.NewReader(out))
		r.ContentLength = int64(len(out))
	}
}
