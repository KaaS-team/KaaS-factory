//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package scim_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/ee/scim"
)

const token = "scim-token"

// do sends one request. IdPs always put "schemas" in a create or replace body, so do adds the
// resource schema when a body has none.
func do(t *testing.T, h http.Handler, method, path, body, tok string) *httptest.ResponseRecorder {
	t.Helper()
	if strings.HasPrefix(body, "{\"") && !strings.Contains(body, `"schemas"`) {
		kind := "User"
		if strings.Contains(path, "/Groups") {
			kind = "Group"
		}
		body = `{"schemas":["urn:ietf:params:scim:schemas:core:2.0:` + kind + `"],` + body[1:]
	}
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+tok)
	r.Header.Set("Content-Type", "application/scim+json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("body %q: %v", w.Body.String(), err)
	}
	return m
}

func TestUserLifecycle(t *testing.T) {
	h := scim.NewTenantHandler(scim.NewMemoryStore(), map[string]string{token: "t"}, nil)
	w := do(t, h, "POST", "/scim/v2/Users", `{"userName":"Bo@Acme.example","externalId":"x1"}`, token)
	if w.Code != 201 || w.Header().Get("Content-Type") != "application/scim+json" {
		t.Fatalf("create: %d %s", w.Code, w.Header().Get("Content-Type"))
	}
	u := decode(t, w)
	id := u["id"].(string)
	if u["userName"] != "bo@acme.example" || u["active"] != true || u["schemas"].([]any)[0] != "urn:ietf:params:scim:schemas:core:2.0:User" {
		t.Fatalf("user %v", u)
	}
	if loc := u["meta"].(map[string]any)["location"]; loc != "/scim/v2/Users/"+id {
		t.Fatalf("location %v", loc)
	}
	if w := do(t, h, "POST", "/scim/v2/Users", `{"userName":"bo@acme.example"}`, token); w.Code != 409 || decode(t, w)["scimType"] != "uniqueness" {
		t.Fatalf("dup: %d %s", w.Code, w.Body)
	}
	do(t, h, "POST", "/scim/v2/Users", `{"userName":"alice@acme.example"}`, token)

	w = do(t, h, "GET", `/scim/v2/Users?filter=userName%20eq%20%22bo%40acme.example%22`, "", token)
	l := decode(t, w)
	if w.Code != 200 || l["totalResults"] != float64(1) || l["schemas"].([]any)[0] != "urn:ietf:params:scim:api:messages:2.0:ListResponse" || l["startIndex"] != float64(1) {
		t.Fatalf("filter: %d %v", w.Code, l)
	}
	if all := decode(t, do(t, h, "GET", "/scim/v2/Users", "", token)); all["totalResults"] != float64(2) {
		t.Fatalf("list %v", all)
	}
	if w := do(t, h, "GET", `/scim/v2/Users?filter=bogus`, "", token); w.Code != 400 {
		t.Fatalf("bad filter %d", w.Code)
	}

	patch := `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","value":{"active":false}}]}`
	w = do(t, h, "PATCH", "/scim/v2/Users/"+id, patch, token)
	if w.Code != 200 || decode(t, w)["active"] != false {
		t.Fatalf("patch: %d %s", w.Code, w.Body)
	}
	// Okta sends the path form, with a capitalised op.
	w = do(t, h, "PATCH", "/scim/v2/Users/"+id, `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"Replace","path":"active","value":true}]}`, token)
	if decode(t, w)["active"] != true {
		t.Fatalf("reactivate: %s", w.Body)
	}
	if w := do(t, h, "PATCH", "/scim/v2/Users/"+id, `{"schemas":[],"Operations":[]}`, token); w.Code != 400 {
		t.Fatalf("no PatchOp schema: %d", w.Code)
	}
	if w := do(t, h, "PATCH", "/scim/v2/Users/"+id, `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"remove","path":"active"}]}`, token); w.Code != 400 {
		t.Fatalf("remove op: %d", w.Code)
	}

	if w := do(t, h, "DELETE", "/scim/v2/Users/"+id, "", token); w.Code != 204 {
		t.Fatalf("delete %d", w.Code)
	}
	w = do(t, h, "GET", "/scim/v2/Users/"+id, "", token)
	if e := decode(t, w); w.Code != 404 || e["schemas"].([]any)[0] != "urn:ietf:params:scim:api:messages:2.0:Error" || e["status"] != "404" {
		t.Fatalf("after delete %d %v", w.Code, e)
	}
	if w := do(t, h, "DELETE", "/scim/v2/Users/"+id, "", token); w.Code != 404 {
		t.Fatalf("delete twice %d", w.Code)
	}
}

func TestAuthAndValidation(t *testing.T) {
	h := scim.NewTenantHandler(scim.NewMemoryStore(), map[string]string{token: "t"}, nil)
	for name, tc := range map[string]struct {
		method, path, body, tok string
		want                    int
	}{
		"wrong token":    {"GET", "/scim/v2/Users", "", "wrong", 401},
		"empty token":    {"GET", "/scim/v2/Users", "", "", 401},
		"github-shaped":  {"POST", "/scim/v2/Users", `{"userName":"octocat"}`, token, 400},
		"bad json":       {"POST", "/scim/v2/Users", `{`, token, 400},
		"unknown path":   {"GET", "/scim/v2/Nope", "", token, 404},
		"missing user":   {"GET", "/scim/v2/Users/nope", "", token, 404},
		"collection PUT": {"PUT", "/scim/v2/Users", "", token, 404},
	} {
		t.Run(name, func(t *testing.T) {
			if w := do(t, h, tc.method, tc.path, tc.body, tc.tok); w.Code != tc.want {
				t.Fatalf("got %d %s", w.Code, w.Body)
			}
		})
	}
	// A server with no token configured refuses everything.
	if w := do(t, scim.NewHandler(scim.NewMemoryStore(), ""), "GET", "/scim/v2/Users", "", ""); w.Code != 401 {
		t.Fatalf("no configured token: %d", w.Code)
	}
}

func TestGroups(t *testing.T) {
	h := scim.NewTenantHandler(scim.NewMemoryStore(), map[string]string{token: "t"}, nil)
	uid := decode(t, do(t, h, "POST", "/scim/v2/Users", `{"userName":"bo@acme.example"}`, token))["id"].(string)
	w := do(t, h, "POST", "/scim/v2/Groups", `{"displayName":"release-managers","members":[{"value":"`+uid+`"}]}`, token)
	g := decode(t, w)
	if w.Code != 201 || g["schemas"].([]any)[0] != "urn:ietf:params:scim:schemas:core:2.0:Group" || g["displayName"] != "release-managers" || len(g["members"].([]any)) != 1 {
		t.Fatalf("create group: %d %v", w.Code, g)
	}
	gid := g["id"].(string)
	if w := do(t, h, "POST", "/scim/v2/Groups", `{"displayName":"release-managers"}`, token); w.Code != 409 {
		t.Fatalf("dup group %d", w.Code)
	}
	if w := do(t, h, "POST", "/scim/v2/Groups", `{"displayName":"x","members":[{"value":"ghost"}]}`, token); w.Code != 400 {
		t.Fatalf("unknown member %d", w.Code)
	}
	if l := decode(t, do(t, h, "GET", `/scim/v2/Groups?filter=displayName%20eq%20%22release-managers%22`, "", token)); l["totalResults"] != float64(1) {
		t.Fatalf("filter %v", l)
	}
	patch := `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"remove","path":"members"}]}`
	if w := do(t, h, "PATCH", "/scim/v2/Groups/"+gid, patch, token); w.Code != 200 || len(decode(t, w)["members"].([]any)) != 0 {
		t.Fatalf("clear members %d %s", w.Code, w.Body)
	}
	add := `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"add","path":"members","value":[{"value":"` + uid + `"}]}]}`
	if w := do(t, h, "PATCH", "/scim/v2/Groups/"+gid, add, token); len(decode(t, w)["members"].([]any)) != 1 {
		t.Fatalf("add member %s", w.Body)
	}
	// Deleting a user takes them out of every group.
	do(t, h, "DELETE", "/scim/v2/Users/"+uid, "", token)
	if g := decode(t, do(t, h, "GET", "/scim/v2/Groups/"+gid, "", token)); len(g["members"].([]any)) != 0 {
		t.Fatalf("member survived user delete: %v", g)
	}
	if w := do(t, h, "DELETE", "/scim/v2/Groups/"+gid, "", token); w.Code != 204 {
		t.Fatalf("delete group %d", w.Code)
	}
}
