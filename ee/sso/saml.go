//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package sso

import (
	"crypto/subtle"
	"encoding/xml"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/crewjam/saml"
	dsig "github.com/russellhaering/goxmldsig"
)

const samlCookie = "factory_saml"

// SAMLConfig names the IdP the SP trusts and where this SP lives. OnSession receives each
// successful sign-in. EmailAttribute and GroupsAttribute default to "email" and "groups"; when the
// assertion has no email attribute, a NameID that looks like an email address is used.
type SAMLConfig struct {
	IDPMetadata     *saml.EntityDescriptor
	EntityID        string
	ACSURL          string
	EmailAttribute  string
	GroupsAttribute string
	OnSession       func(http.ResponseWriter, *http.Request, Session)
	// Clock replaces the wall clock for validity checks; nil means the real time.
	Clock *dsig.Clock
}

// SAML serves SP-initiated SAML 2.0 sign-in: Login redirects to the IdP, ACS consumes its answer.
type SAML struct {
	cfg    SAMLConfig
	sp     *saml.ServiceProvider
	replay *replayCache
}

// NewSAML builds the flow. It fails when the IdP metadata carries no signing key, because an
// unsigned or unverifiable assertion is never accepted.
func NewSAML(cfg SAMLConfig) (*SAML, error) {
	if cfg.IDPMetadata == nil || cfg.EntityID == "" || cfg.ACSURL == "" {
		return nil, errors.New("sso: IdP metadata, entity id and ACS url are required")
	}
	if cfg.OnSession == nil {
		return nil, errors.New("sso: OnSession is required")
	}
	acs, err := url.Parse(cfg.ACSURL)
	if err != nil || acs.Scheme == "" || acs.Host == "" {
		return nil, errors.New("sso: ACS url is not absolute")
	}
	if len(cfg.IDPMetadata.IDPSSODescriptors) == 0 {
		return nil, errors.New("sso: IdP metadata has no IDPSSODescriptor")
	}
	if cfg.EmailAttribute == "" {
		cfg.EmailAttribute = "email"
	}
	if cfg.GroupsAttribute == "" {
		cfg.GroupsAttribute = "groups"
	}
	meta := *acs
	meta.Path = strings.TrimSuffix(acs.Path, "/acs") + "/metadata"
	rc := &replayCache{seen: map[string]time.Time{}, now: func() time.Time { return samlNow(cfg.Clock) }}
	return &SAML{cfg: cfg, replay: rc, sp: &saml.ServiceProvider{
		EntityID: cfg.EntityID, AcsURL: *acs, MetadataURL: meta, IDPMetadata: cfg.IDPMetadata,
		Clock: cfg.Clock, ReplayCache: rc, RejectSHA1Signatures: true,
		AuthnNameIDFormat: saml.UnspecifiedNameIDFormat,
	}}, nil
}

// Metadata returns the SP descriptor the IdP is configured with.
func (s *SAML) Metadata() *saml.EntityDescriptor { return s.sp.Metadata() }

// ServeMetadata writes the SP metadata XML.
func (s *SAML) ServeMetadata(w http.ResponseWriter, _ *http.Request) {
	b, err := xml.MarshalIndent(s.sp.Metadata(), "", "  ")
	if err != nil {
		http.Error(w, "metadata unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/samlmetadata+xml")
	_, _ = w.Write(b)
}

func setSAMLFlow(w http.ResponseWriter, value string, maxAge int) {
	// SameSite=None because the IdP posts back cross-site; browsers require Secure with it.
	http.SetCookie(w, &http.Cookie{Name: samlCookie, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteNoneMode})
}

// Login redirects to the IdP with an AuthnRequest. The request ID and a relay state are kept in a
// short cookie so ACS only accepts an answer to a request this browser started.
func (s *SAML) Login(w http.ResponseWriter, r *http.Request) {
	req, err := s.sp.MakeAuthenticationRequest(s.sp.GetSSOBindingLocation(saml.HTTPRedirectBinding), saml.HTTPRedirectBinding, saml.HTTPPostBinding)
	if err != nil {
		http.Error(w, "the IdP cannot be reached, check its metadata", http.StatusInternalServerError)
		return
	}
	relay := random(16)
	to, err := req.Redirect(relay, s.sp)
	if err != nil {
		http.Error(w, "the sign-in request could not be built", http.StatusInternalServerError)
		return
	}
	setSAMLFlow(w, relay+"."+req.ID, flowTTL)
	http.Redirect(w, r, to.String(), http.StatusFound)
}

// ACS verifies the posted response and hands the session to OnSession. A missing cookie or a
// relay state that does not match is a 400; anything wrong with the assertion is a 401.
func (s *SAML) ACS(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(samlCookie)
	relay, id, ok := "", "", false
	if err == nil {
		relay, id, ok = strings.Cut(c.Value, ".")
	}
	if err := r.ParseForm(); err != nil || !ok || subtle.ConstantTimeCompare([]byte(r.PostForm.Get("RelayState")), []byte(relay)) != 1 {
		http.Error(w, "sign-in expired, start again", http.StatusBadRequest)
		return
	}
	setSAMLFlow(w, "", -1)
	a, err := s.sp.ParseResponse(r, []string{id})
	if err != nil {
		http.Error(w, "the IdP's answer was refused", http.StatusUnauthorized)
		return
	}
	sess, err := s.session(a)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	s.cfg.OnSession(w, r, sess)
}

func (s *SAML) session(a *saml.Assertion) (Session, error) {
	email, groups := "", []string{}
	for _, st := range a.AttributeStatements {
		for _, at := range st.Attributes {
			switch {
			case at.Name == s.cfg.EmailAttribute || at.FriendlyName == s.cfg.EmailAttribute:
				for _, v := range at.Values {
					if email == "" {
						email = v.Value
					}
				}
			case at.Name == s.cfg.GroupsAttribute || at.FriendlyName == s.cfg.GroupsAttribute:
				for _, v := range at.Values {
					groups = append(groups, v.Value)
				}
			}
		}
	}
	if email == "" && a.Subject != nil && a.Subject.NameID != nil && strings.Contains(a.Subject.NameID.Value, "@") {
		email = a.Subject.NameID.Value
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return Session{}, errors.New("the IdP did not vouch for an email address")
	}
	return Session{Email: email, Groups: groups}, nil
}

func samlNow(c *dsig.Clock) time.Time {
	if c == nil {
		return time.Now()
	}
	return c.Now()
}

// replayCache remembers assertion IDs until their validity ends.
type replayCache struct {
	mu   sync.Mutex
	seen map[string]time.Time
	now  func() time.Time
}

func (c *replayCache) Consume(id string, expiresAt time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, exp := range c.seen {
		if !exp.After(now) {
			delete(c.seen, k)
		}
	}
	if _, dup := c.seen[id]; dup {
		return saml.ErrAssertionReplayed
	}
	c.seen[id] = expiresAt
	return nil
}
