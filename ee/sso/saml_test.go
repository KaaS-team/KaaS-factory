//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package sso_test

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"html"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/beevik/etree"
	"github.com/crewjam/saml"
	"github.com/crewjam/saml/logger"
	"github.com/jonboulle/clockwork"
	dsig "github.com/russellhaering/goxmldsig"

	"github.com/KaaS-team/factory/ee/sso"
)

// testIdP is a SAML IdP with a generated key. It signs whatever session its user holds.
type testIdP struct {
	idp  *saml.IdentityProvider
	srv  *httptest.Server
	user saml.Session
}

func (p *testIdP) GetSession(_ http.ResponseWriter, _ *http.Request, _ *saml.IdpAuthnRequest) *saml.Session {
	s := p.user
	return &s
}

func newIdP(t *testing.T, spMeta func() *saml.EntityDescriptor) *testIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test idp"},
		NotBefore: time.Now().Add(-24 * time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	p := &testIdP{user: saml.Session{
		ID: "s1", CreateTime: time.Now(), ExpireTime: time.Now().Add(time.Hour), Index: "1",
		NameID: "Ada@Example.com", NameIDFormat: string(saml.EmailAddressNameIDFormat),
		UserEmail: "Ada@Example.com",
		CustomAttributes: []saml.Attribute{{Name: "groups", Values: []saml.AttributeValue{
			{Type: "xs:string", Value: "eng"}, {Type: "xs:string", Value: "admins"}}}},
	}}
	mux := http.NewServeMux()
	p.srv = httptest.NewServer(mux)
	t.Cleanup(p.srv.Close)
	u, _ := url.Parse(p.srv.URL)
	p.idp = &saml.IdentityProvider{
		Key: key, Signer: key, Certificate: cert,
		MetadataURL: *u.JoinPath("/metadata"), SSOURL: *u.JoinPath("/sso"),
		Logger: logger.DefaultLogger, SessionProvider: p,
		ServiceProviderProvider: spProvider(spMeta),
	}
	mux.HandleFunc("/sso", p.idp.ServeSSO)
	return p
}

type spProvider func() *saml.EntityDescriptor

func (f spProvider) GetServiceProvider(*http.Request, string) (*saml.EntityDescriptor, error) {
	return f(), nil
}

type rig struct {
	idp  *testIdP
	flow *sso.SAML
	got  []sso.Session
}

var formValue = regexp.MustCompile(`name="SAMLResponse" value="([^"]*)"`)

func newRig(t *testing.T, mutate func(*sso.SAMLConfig)) *rig {
	t.Helper()
	r := &rig{}
	var flow *sso.SAML
	r.idp = newIdP(t, func() *saml.EntityDescriptor { return flow.Metadata() })
	cfg := sso.SAMLConfig{
		IDPMetadata: r.idp.idp.Metadata(),
		EntityID:    "https://factory.example/saml/metadata",
		ACSURL:      "https://factory.example/saml/acs",
		OnSession: func(w http.ResponseWriter, _ *http.Request, s sso.Session) {
			r.got = append(r.got, s)
			w.WriteHeader(http.StatusNoContent)
		},
	}
	if mutate != nil {
		mutate(&cfg)
	}
	var err error
	flow, err = sso.NewSAML(cfg)
	if err != nil {
		t.Fatal(err)
	}
	r.flow = flow
	return r
}

// login runs the redirect leg and the IdP leg, returning the base64 SAMLResponse and the flow cookie.
func (r *rig) login(t *testing.T) (string, *http.Cookie) {
	t.Helper()
	w := httptest.NewRecorder()
	r.flow.Login(w, httptest.NewRequest("GET", "https://factory.example/saml/login", nil))
	if w.Code != http.StatusFound {
		t.Fatalf("login status %d", w.Code)
	}
	loc, _ := url.Parse(w.Header().Get("Location"))
	if !strings.HasPrefix(loc.String(), r.idp.srv.URL+"/sso") || loc.Query().Get("SAMLRequest") == "" {
		t.Fatalf("login did not redirect to the IdP %s: %s", r.idp.srv.URL, loc)
	}
	// Point the IdP at the ACS the SP asked for.
	resp, err := http.Get(loc.String())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	m := formValue.FindSubmatch(body)
	if m == nil {
		t.Fatalf("no SAMLResponse in IdP reply: %s", body)
	}
	return html.UnescapeString(string(m[1])), w.Result().Cookies()[0]
}

func (r *rig) acs(t *testing.T, response string, cookie *http.Cookie, relay string) *httptest.ResponseRecorder {
	t.Helper()
	form := url.Values{"SAMLResponse": {response}, "RelayState": {relay}}
	req := httptest.NewRequest("POST", "https://factory.example/saml/acs", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	r.flow.ACS(w, req)
	return w
}

func relayOf(c *http.Cookie) string { return strings.SplitN(c.Value, ".", 2)[0] }

func TestSAMLRoundTrip(t *testing.T) {
	r := newRig(t, nil)
	resp, cookie := r.login(t)
	w := r.acs(t, resp, cookie, relayOf(cookie))
	if w.Code != http.StatusNoContent || len(r.got) != 1 {
		t.Fatalf("status %d, sessions %d: %s", w.Code, len(r.got), w.Body)
	}
	s := r.got[0]
	if s.Email != "ada@example.com" || len(s.Groups) != 2 || s.Groups[0] != "eng" || s.Groups[1] != "admins" {
		t.Fatalf("session %+v", s)
	}
}

func TestSAMLMetadata(t *testing.T) {
	r := newRig(t, nil)
	w := httptest.NewRecorder()
	r.flow.Metadata()
	r.flow.ServeMetadata(w, httptest.NewRequest("GET", "/saml/metadata", nil))
	b := w.Body.String()
	for _, want := range []string{"https://factory.example/saml/metadata", "https://factory.example/saml/acs", "SPSSODescriptor"} {
		if !strings.Contains(b, want) {
			t.Errorf("metadata lacks %q: %s", want, b)
		}
	}
}

// resign rewrites the response XML, e.g. to strip its signatures.
func rewrite(t *testing.T, resp string, f func(*etree.Document)) string {
	t.Helper()
	raw, _ := base64.StdEncoding.DecodeString(resp)
	doc := etree.NewDocument()
	if err := doc.ReadFromBytes(raw); err != nil {
		t.Fatal(err)
	}
	f(doc)
	out, _ := doc.WriteToBytes()
	return base64.StdEncoding.EncodeToString(out)
}

func stripSignatures(d *etree.Document) {
	for _, s := range d.FindElements("//Signature") {
		s.Parent().RemoveChild(s)
	}
}

// TestSAMLRefusals is the table of assertions the ACS must turn away. Each row must leave OnSession uncalled.
func TestSAMLRefusals(t *testing.T) {
	clock := clockwork.NewFakeClockAt(time.Now())
	cases := []struct {
		name   string
		mutate func(*sso.SAMLConfig) // changes what the SP trusts or when it thinks it is
		resp   func(t *testing.T, r *rig, resp string) string
		relay  func(string) string
		status int
	}{
		{name: "unsigned", status: 401,
			resp: func(t *testing.T, _ *rig, resp string) string { return rewrite(t, resp, stripSignatures) }},
		{name: "wrong key", status: 401,
			// The SP trusts a different IdP key than the one that signed.
			mutate: func(c *sso.SAMLConfig) {
				other := newIdP(t, func() *saml.EntityDescriptor { return nil }).idp.Metadata()
				c.IDPMetadata.IDPSSODescriptors[0].KeyDescriptors = other.IDPSSODescriptors[0].KeyDescriptors
			}},
		{name: "expired", status: 401, mutate: func(c *sso.SAMLConfig) { c.Clock = dsig.NewFakeClock(clock) },
			// The IdP signed a minute ago; two hours later the assertion is past its validity.
			resp: func(_ *testing.T, _ *rig, resp string) string { clock.Advance(2 * time.Hour); return resp }},
		{name: "wrong relay state", status: 400, relay: func(string) string { return "other" }},
		{name: "garbage", status: 401,
			resp: func(*testing.T, *rig, string) string { return base64.StdEncoding.EncodeToString([]byte("<nope/>")) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t, c.mutate)
			resp, cookie := r.login(t)
			if c.resp != nil {
				resp = c.resp(t, r, resp)
			}
			relay := relayOf(cookie)
			if c.relay != nil {
				relay = c.relay(relay)
			}
			w := r.acs(t, resp, cookie, relay)
			if w.Code != c.status || len(r.got) != 0 {
				t.Fatalf("status %d (want %d), sessions %d: %s", w.Code, c.status, len(r.got), w.Body)
			}
		})
	}
	t.Run("replayed", func(t *testing.T) {
		r := newRig(t, nil)
		resp, cookie := r.login(t)
		if w := r.acs(t, resp, cookie, relayOf(cookie)); w.Code != http.StatusNoContent {
			t.Fatalf("first use: %d %s", w.Code, w.Body)
		}
		if w := r.acs(t, resp, cookie, relayOf(cookie)); w.Code != 401 || len(r.got) != 1 {
			t.Fatalf("replay: status %d, sessions %d", w.Code, len(r.got))
		}
	})
	t.Run("no cookie", func(t *testing.T) {
		r := newRig(t, nil)
		resp, _ := r.login(t)
		if w := r.acs(t, resp, nil, "x"); w.Code != 400 || len(r.got) != 0 {
			t.Fatalf("status %d", w.Code)
		}
	})
}

func TestSAMLConfigRequired(t *testing.T) {
	if _, err := sso.NewSAML(sso.SAMLConfig{}); err == nil {
		t.Fatal("empty config accepted")
	}
}
