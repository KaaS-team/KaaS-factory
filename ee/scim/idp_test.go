//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package scim_test

import (
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/KaaS-team/factory/ee/scim"
)

const patchOp = "urn:ietf:params:scim:api:messages:2.0:PatchOp"

type sink struct {
	mu     sync.Mutex
	events []scim.Event
}

func (s *sink) record(e scim.Event) { s.mu.Lock(); s.events = append(s.events, e); s.mu.Unlock() }

func tenantHandler(t *testing.T) (http.Handler, *sink) {
	t.Helper()
	s := &sink{}
	return scim.NewTenantHandler(scim.NewMemoryStore(), map[string]string{"tok-acme": "acme", "tok-globex": "globex"}, s.record), s
}

// TestDiscoveryEndpoints: ServiceProviderConfig, Schemas and ResourceTypes answer (RFC 7644 section 4).
func TestDiscoveryEndpoints(t *testing.T) {
	h, _ := tenantHandler(t)
	for path, want := range map[string]string{
		"/scim/v2/ServiceProviderConfig": "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
		"/scim/v2/Schemas":               "urn:ietf:params:scim:schemas:core:2.0:Group",
		"/scim/v2/ResourceTypes":         `"endpoint":"/Users"`,
	} {
		w := do(t, h, "GET", path, "", "tok-acme")
		if w.Code != 200 || !strings.Contains(w.Body.String(), want) {
			t.Errorf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	if w := do(t, h, "GET", "/scim/v2/Schemas", "", "nope"); w.Code != 401 {
		t.Errorf("discovery without a token: %d", w.Code)
	}
}

// TestReplace: PUT replaces a user and a group, and keeps the id.
func TestReplace(t *testing.T) {
	h, _ := tenantHandler(t)
	uid := decode(t, do(t, h, "POST", "/scim/v2/Users", `{"userName":"bo@acme.example"}`, "tok-acme"))["id"].(string)
	w := do(t, h, "PUT", "/scim/v2/Users/"+uid, `{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"bo.new@acme.example","active":false,"externalId":"e9"}`, "tok-acme")
	u := decode(t, w)
	if w.Code != 200 || u["id"] != uid || u["userName"] != "bo.new@acme.example" || u["active"] != false || u["externalId"] != "e9" {
		t.Fatalf("replace user: %d %v", w.Code, u)
	}
	gid := decode(t, do(t, h, "POST", "/scim/v2/Groups", `{"displayName":"dev","members":[{"value":"`+uid+`"}]}`, "tok-acme"))["id"].(string)
	w = do(t, h, "PUT", "/scim/v2/Groups/"+gid, `{"schemas":["urn:ietf:params:scim:schemas:core:2.0:Group"],"displayName":"devs","members":[]}`, "tok-acme")
	g := decode(t, w)
	if w.Code != 200 || g["id"] != gid || g["displayName"] != "devs" || len(g["members"].([]any)) != 0 {
		t.Fatalf("replace group: %d %v", w.Code, g)
	}
	if w := do(t, h, "PUT", "/scim/v2/Users/ghost", `{"userName":"x@acme.example"}`, "tok-acme"); w.Code != 404 {
		t.Fatalf("replace missing: %d", w.Code)
	}
}

// TestTenantScoping: each token sees only its own tenant's users and groups.
func TestTenantScoping(t *testing.T) {
	h, _ := tenantHandler(t)
	a := decode(t, do(t, h, "POST", "/scim/v2/Users", `{"userName":"bo@shared.example"}`, "tok-acme"))["id"].(string)
	if w := do(t, h, "POST", "/scim/v2/Users", `{"userName":"bo@shared.example"}`, "tok-globex"); w.Code != 201 {
		t.Fatalf("same userName in another tenant: %d %s", w.Code, w.Body)
	}
	ga := decode(t, do(t, h, "POST", "/scim/v2/Groups", `{"displayName":"ops"}`, "tok-acme"))["id"].(string)
	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/scim/v2/Users/" + a, ""},
		{"PUT", "/scim/v2/Users/" + a, `{"userName":"x@shared.example"}`},
		{"PATCH", "/scim/v2/Users/" + a, `{"schemas":["` + patchOp + `"],"Operations":[{"op":"replace","path":"active","value":false}]}`},
		{"DELETE", "/scim/v2/Users/" + a, ""},
		{"GET", "/scim/v2/Groups/" + ga, ""},
		{"DELETE", "/scim/v2/Groups/" + ga, ""},
	} {
		if w := do(t, h, tc.method, tc.path, tc.body, "tok-globex"); w.Code != 404 {
			t.Errorf("globex %s %s: %d, want 404", tc.method, tc.path, w.Code)
		}
	}
	if l := decode(t, do(t, h, "GET", "/scim/v2/Users", "", "tok-globex")); l["totalResults"] != float64(1) {
		t.Errorf("globex list: %v", l)
	}
	if g := decode(t, do(t, h, "GET", "/scim/v2/Users/"+a, "", "tok-acme")); g["active"] != true {
		t.Errorf("acme user was touched by globex: %v", g)
	}
	if w := do(t, h, "POST", "/scim/v2/Groups", `{"displayName":"x","members":[{"value":"`+a+`"}]}`, "tok-globex"); w.Code != 400 {
		t.Errorf("group member from another tenant: %d", w.Code)
	}
}

// TestIdPPayloads replays the request shapes Okta and Entra send.
func TestIdPPayloads(t *testing.T) {
	h, _ := tenantHandler(t)
	call := func(method, path, body string, want int) map[string]any {
		t.Helper()
		w := do(t, h, method, path, body, "tok-acme")
		if w.Code != want {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body)
		}
		if w.Body.Len() == 0 {
			return nil
		}
		return decode(t, w)
	}
	// Okta: a lookup, a create with a name and emails, deactivation through a value object.
	if l := call("GET", `/scim/v2/Users?filter=userName%20eq%20%22bo%40acme.example%22&startIndex=1&count=100`, "", 200); l["totalResults"] != float64(0) {
		t.Fatalf("okta lookup: %v", l)
	}
	oktaUser := `{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"bo@acme.example","name":{"givenName":"Bo","familyName":"Li"},"emails":[{"primary":true,"value":"bo@acme.example","type":"work"}],"displayName":"Bo Li","locale":"en-US","externalId":"00u1","active":true,"groups":[]}`
	id := call("POST", "/scim/v2/Users", oktaUser, 201)["id"].(string)
	if u := call("PATCH", "/scim/v2/Users/"+id, `{"schemas":["`+patchOp+`"],"Operations":[{"op":"replace","value":{"active":false}}]}`, 200); u["active"] != false {
		t.Fatalf("okta deactivate: %v", u)
	}
	// Entra: PascalCase op, string "True", then a members patch.
	if u := call("PATCH", "/scim/v2/Users/"+id, `{"schemas":["`+patchOp+`"],"Operations":[{"op":"Replace","path":"active","value":"True"}]}`, 200); u["active"] != true {
		t.Fatalf("entra reactivate: %v", u)
	}
	gid := call("POST", "/scim/v2/Groups", `{"schemas":["urn:ietf:params:scim:schemas:core:2.0:Group"],"displayName":"Engineers","externalId":"g1","members":[]}`, 201)["id"].(string)
	call("PATCH", "/scim/v2/Groups/"+gid, `{"schemas":["`+patchOp+`"],"Operations":[{"op":"Add","path":"members","value":[{"value":"`+id+`"}]}]}`, 200)
	if g := call("GET", "/scim/v2/Groups/"+gid, "", 200); len(g["members"].([]any)) != 1 {
		t.Fatalf("entra add member: %v", g)
	}
	other := call("POST", "/scim/v2/Users", `{"userName":"al@acme.example"}`, 201)["id"].(string)
	call("PATCH", "/scim/v2/Groups/"+gid, `{"schemas":["`+patchOp+`"],"Operations":[{"op":"Add","path":"members","value":[{"value":"`+other+`"}]}]}`, 200)
	call("PATCH", "/scim/v2/Groups/"+gid, `{"schemas":["`+patchOp+`"],"Operations":[{"op":"Remove","path":"members[value eq \"`+id+`\"]"}]}`, 200)
	if g := call("GET", "/scim/v2/Groups/"+gid, "", 200); len(g["members"].([]any)) != 1 || g["members"].([]any)[0].(map[string]any)["value"] != other {
		t.Fatalf("entra remove member by filter: %v", g)
	}
	// Entra lookup by externalId and a paged list.
	if l := call("GET", `/scim/v2/Users?filter=externalId%20eq%20%2200u1%22`, "", 200); l["totalResults"] != float64(1) {
		t.Fatalf("externalId filter: %v", l)
	}
	if l := call("GET", `/scim/v2/Users?startIndex=3&count=1`, "", 200); l["totalResults"] != float64(2) || len(l["Resources"].([]any)) != 0 {
		t.Fatalf("paging past the end: %v", l)
	}
	if l := call("GET", `/scim/v2/Users?startIndex=1&count=1`, "", 200); l["totalResults"] != float64(2) || len(l["Resources"].([]any)) != 1 {
		t.Fatalf("one-item page: %v", l)
	}
}

// TestEveryCallIsAudited: each request, including a refused one, writes one audit event.
func TestEveryCallIsAudited(t *testing.T) {
	h, s := tenantHandler(t)
	do(t, h, "POST", "/scim/v2/Users", `{"userName":"bo@acme.example"}`, "tok-acme")
	do(t, h, "GET", "/scim/v2/Users/ghost", "", "tok-globex")
	do(t, h, "GET", "/scim/v2/Users", "", "wrong")
	want := []scim.Event{
		{Tenant: "acme", Method: "POST", Path: "/scim/v2/Users", Status: 201},
		{Tenant: "globex", Method: "GET", Path: "/scim/v2/Users/ghost", Status: 404},
		{Tenant: "", Method: "GET", Path: "/scim/v2/Users", Status: 401},
	}
	if len(s.events) != len(want) {
		t.Fatalf("events %v", s.events)
	}
	for i, e := range want {
		if s.events[i] != e {
			t.Errorf("event %d: %+v, want %+v", i, s.events[i], e)
		}
	}
}

// TestEmptyBearerRefused: "Bearer " with nothing after it never matches, even if an empty token was configured.
func TestEmptyBearerRefused(t *testing.T) {
	h := scim.NewTenantHandler(scim.NewMemoryStore(), map[string]string{"": "acme"}, nil)
	if w := do(t, h, "GET", "/scim/v2/Users", "", ""); w.Code != 401 {
		t.Fatalf("empty bearer: %d", w.Code)
	}
}
