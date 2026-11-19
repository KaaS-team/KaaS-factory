package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// TestBearerNotSentOnCrossHostRedirect: a 302 to another host must not carry the token.
func TestBearerNotSentOnCrossHostRedirect(t *testing.T) {
	var gotOther, gotAPI string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOther = r.Header.Get("Authorization")
	}))
	defer other.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAPI = r.Header.Get("Authorization")
		http.Redirect(w, r, other.URL+"/x", http.StatusFound)
	}))
	defer api.Close()
	u, _ := url.Parse(api.URL)
	c := &http.Client{Transport: bearer{"SECRET", u.Host, http.DefaultTransport}}
	res, err := c.Get(api.URL + "/start")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if gotAPI != "Bearer SECRET" {
		t.Errorf("API host Authorization = %q, want the token", gotAPI)
	}
	if gotOther != "" {
		t.Errorf("redirect target got Authorization %q, want none", gotOther)
	}
}
