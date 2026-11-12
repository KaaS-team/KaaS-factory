package a2a

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
	"github.com/a2aproject/a2a-go/v2/a2acrypto"

	"github.com/KaaS-team/factory/internal/api"
)

type bearerRT struct{ token string }

func (b bearerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if b.token != "" {
		r.Header.Set("Authorization", "Bearer "+b.token)
	}
	return http.DefaultTransport.RoundTrip(r)
}

type memAudit struct {
	mu   sync.Mutex
	rows []AuditRow
	err  error
}

func (m *memAudit) Record(_ context.Context, r AuditRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows = append(m.rows, r)
	return m.err
}

func (m *memAudit) get() []AuditRow {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]AuditRow(nil), m.rows...)
}

// v1Server serves the handler over HTTP and returns a v1 client that carries the token.
func v1Server(t *testing.T, deps Deps, token string) (*a2aclient.Client, string) {
	t.Helper()
	var h http.Handler
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.ServeHTTP(w, r) }))
	t.Cleanup(srv.Close)
	deps.URL = srv.URL
	h = mustHandler(t, deps)
	c, err := a2aclient.NewFromEndpoints(context.Background(),
		[]*sdk.AgentInterface{{URL: srv.URL, ProtocolBinding: sdk.TransportProtocolJSONRPC, ProtocolVersion: sdk.Version}},
		a2aclient.WithJSONRPCTransport(&http.Client{Transport: bearerRT{token}}))
	if err != nil {
		t.Fatal(err)
	}
	return c, srv.URL
}

func userMsg(text string) *sdk.SendMessageRequest {
	return &sdk.SendMessageRequest{
		Message: sdk.NewMessage(sdk.MessageRoleUser, sdk.NewTextPart(text)),
		Config:  &sdk.SendMessageConfig{ReturnImmediately: true},
	}
}

// Acceptance: message/send works over A2A v1 and a get reads the ticket's phase.
func TestV1SendAndGet(t *testing.T) {
	deps, tr, ob := newDeps()
	st := deps.Filer.(*fakeStore)
	c, _ := v1Server(t, deps, testToken)
	ctx := context.Background()

	res, err := c.SendMessage(ctx, userMsg("add a health endpoint"))
	if err != nil {
		t.Fatal(err)
	}
	task, ok := res.(*sdk.Task)
	if !ok || task.Status.State != sdk.TaskStateSubmitted {
		t.Fatalf("send result = %#v", res)
	}
	ticket := api.TicketID(task.Metadata[MetaTicket].(string))
	if tk, err := tr.Get(ctx, ticket); err != nil || tk.Title != "add a health endpoint" {
		t.Fatalf("ticket = %+v, %v", tk, err)
	}
	for phase, want := range map[api.Phase]sdk.TaskState{api.PhaseRunning: sdk.TaskStateWorking, api.PhaseNeedsHuman: sdk.TaskStateInputRequired} {
		st.set(ticket, phase)
		got, err := c.GetTask(ctx, &sdk.GetTaskRequest{ID: task.ID})
		if err != nil || got.Status.State != want {
			t.Errorf("phase %s: got %v, %v want %s", phase, got, err, want)
		}
	}
	ob.Set(api.Observation{Ticket: ticket, Attempt: 1, PR: 7})
	st.set(ticket, api.PhaseMerged)
	got, err := c.GetTask(ctx, &sdk.GetTaskRequest{ID: task.ID})
	if err != nil || got.Status.State != sdk.TaskStateCompleted || len(got.Artifacts) != 1 ||
		got.Artifacts[0].Parts[0].Text() != "https://github.com/acme/app/pull/7" {
		t.Errorf("merged: %+v, %v", got, err)
	}
}

// Acceptance: streaming works; each phase change is an event and the PR arrives as an artifact before completion.
func TestV1Streaming(t *testing.T) {
	deps, _, ob := newDeps()
	deps.Poll = 5 * time.Millisecond
	st := deps.Filer.(*fakeStore)
	c, _ := v1Server(t, deps, testToken)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var seen []string
	for ev, err := range c.SendStreamingMessage(ctx, userMsg("add a health endpoint")) {
		if err != nil {
			t.Fatal(err)
		}
		switch v := ev.(type) {
		case *sdk.Task:
			seen = append(seen, "task:"+string(v.Status.State))
			id := api.TicketID(v.Metadata[MetaTicket].(string))
			go func() {
				st.set(id, api.PhaseRunning)
				time.Sleep(50 * time.Millisecond)
				ob.Set(api.Observation{Ticket: id, Attempt: 1, PR: 9})
				st.set(id, api.PhaseMerged)
			}()
		case *sdk.TaskStatusUpdateEvent:
			seen = append(seen, "status:"+string(v.Status.State))
		case *sdk.TaskArtifactUpdateEvent:
			seen = append(seen, "artifact:"+v.Artifact.Parts[0].Text())
		}
	}
	want := "task:TASK_STATE_SUBMITTED status:TASK_STATE_WORKING artifact:https://github.com/acme/app/pull/9 status:TASK_STATE_COMPLETED"
	if got := strings.Join(seen, " "); got != want {
		t.Errorf("events = %s\nwant     %s", got, want)
	}
}

func TestV1RefusalsFileNothing(t *testing.T) {
	deps, tr, _ := newDeps()
	c, _ := v1Server(t, deps, testToken)
	ctx := context.Background()
	if _, err := c.SendMessage(ctx, userMsg("   ")); !errors.Is(err, sdk.ErrInvalidParams) {
		t.Errorf("blank text: %v", err)
	}
	res, err := c.SendMessage(ctx, userMsg("x"))
	if err != nil {
		t.Fatal(err)
	}
	id := res.(*sdk.Task).ID
	if _, err := c.CancelTask(ctx, &sdk.CancelTaskRequest{ID: id}); err == nil {
		t.Error("cancel must be refused")
	}
	if _, err := c.GetTask(ctx, &sdk.GetTaskRequest{ID: "nope"}); !errors.Is(err, sdk.ErrTaskNotFound) {
		t.Errorf("unknown task: %v", err)
	}
	if len(tr.Tickets) != 1 {
		t.Errorf("tickets = %d, want only the one valid send", len(tr.Tickets))
	}
}

func TestV1RejectsMissingToken(t *testing.T) {
	deps, tr, _ := newDeps()
	c, _ := v1Server(t, deps, "")
	if _, err := c.SendMessage(context.Background(), userMsg("x")); err == nil || len(tr.Tickets) != 0 {
		t.Fatalf("unauthenticated v1 send: err=%v tickets=%d", err, len(tr.Tickets))
	}
}

// Acceptance: the interceptor writes one audit row per call, streaming included, and the row holds no request text.
func TestAuditRowPerCall(t *testing.T) {
	deps, _, _ := newDeps()
	deps.Poll = 5 * time.Millisecond
	a := &memAudit{}
	deps.Audit = a
	c, _ := v1Server(t, deps, testToken)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, _ := c.SendMessage(ctx, userMsg("secret request text"))
	id := res.(*sdk.Task).ID
	_, _ = c.GetTask(ctx, &sdk.GetTaskRequest{ID: id})
	_, _ = c.GetTask(ctx, &sdk.GetTaskRequest{ID: "nope"})
	sctx, scancel := context.WithCancel(ctx)
	defer scancel()
	for range c.SendStreamingMessage(sctx, userMsg("more")) {
		scancel() // the first event is enough
	}
	time.Sleep(50 * time.Millisecond)

	rows := a.get()
	if len(rows) != 4 {
		t.Fatalf("rows = %+v, want 4", rows)
	}
	if rows[0].Method != "SendMessage" || rows[0].Task != string(id) || rows[0].Error != "" || rows[0].At.IsZero() {
		t.Errorf("send row = %+v", rows[0])
	}
	if rows[1].Method != "GetTask" || rows[1].Task != string(id) {
		t.Errorf("get row = %+v", rows[1])
	}
	if rows[2].Method != "GetTask" || rows[2].Error == "" {
		t.Errorf("failed get row = %+v", rows[2])
	}
	if rows[3].Method != "SendStreamingMessage" || rows[3].Task == "" {
		t.Errorf("stream row = %+v", rows[3])
	}
	if b, _ := json.Marshal(rows); bytes.Contains(b, []byte("secret request text")) {
		t.Error("an audit row holds request text")
	}
}

// A sink that fails refuses the call rather than letting it go unrecorded.
func TestAuditFailureRefusesCall(t *testing.T) {
	deps, tr, _ := newDeps()
	deps.Audit = &memAudit{err: errors.New("disk full")}
	c, _ := v1Server(t, deps, testToken)
	if _, err := c.GetTask(context.Background(), &sdk.GetTaskRequest{ID: "x"}); err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Errorf("err = %v, want one naming the sink failure", err)
	}
	_ = tr
}

func TestJSONLAuditor(t *testing.T) {
	var buf bytes.Buffer
	a := &JSONLAuditor{W: &buf}
	for i := 0; i < 2; i++ {
		if err := a.Record(context.Background(), AuditRow{Method: "GetTask", At: time.Unix(1, 0).UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"method":"GetTask"`) {
		t.Errorf("lines = %q", lines)
	}
}

// Acceptance: the agent card is signed with a2acrypto and verifies against the JWKS the server publishes.
func TestAgentCardSignedAndVerifies(t *testing.T) {
	deps, _, _ := newDeps()
	_, base := v1Server(t, deps, testToken)
	get := func(path string) []byte {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var b bytes.Buffer
		_, _ = b.ReadFrom(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
		return b.Bytes()
	}
	raw := get("/.well-known/agent-card.json")
	var card sdk.AgentCard
	if err := json.Unmarshal(raw, &card); err != nil || len(card.Signatures) != 1 {
		t.Fatalf("card signatures = %d, err %v", len(card.Signatures), err)
	}
	v := a2acrypto.NewVerifier(a2acrypto.VerifierConfig{
		KeyResolver: a2acrypto.NewJWKSKeyResolver(nil, []string{base + jwksPath}),
	})
	if err := v.Verify(context.Background(), raw, &card.Signatures[0]); err != nil {
		t.Fatalf("verify: %v", err)
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	m["name"] = "evil"
	tampered, _ := json.Marshal(m)
	if err := v.Verify(context.Background(), tampered, &card.Signatures[0]); err == nil {
		t.Error("a tampered card verified")
	}
	if !strings.Contains(string(get(jwksPath)), `"kid"`) {
		t.Error("jwks has no key id")
	}
}

func TestLoadKey(t *testing.T) {
	dir := t.TempDir()
	for name, content := range map[string]string{"empty.pem": "", "junk.pem": "-----BEGIN X-----\nAAAA\n-----END X-----\n"} {
		p := dir + "/" + name
		if err := writeFile(p, content); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadKey(p); err == nil {
			t.Errorf("%s loaded", name)
		}
	}
	if _, err := LoadKey(dir + "/missing.pem"); err == nil {
		t.Error("missing file loaded")
	}
}

func TestLoadKeyAccepted(t *testing.T) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	k384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	sec1, _ := x509.MarshalECPrivateKey(k)
	p8, _ := x509.MarshalPKCS8PrivateKey(k)
	p8384, _ := x509.MarshalPKCS8PrivateKey(k384)
	_, edk, _ := ed25519.GenerateKey(rand.Reader)
	p8ed, _ := x509.MarshalPKCS8PrivateKey(edk)
	dir := t.TempDir()
	for _, tc := range []struct {
		name string
		der  []byte
		ok   bool
	}{{"sec1", sec1, true}, {"pkcs8", p8, true}, {"p384", p8384, false}, {"ed25519", p8ed, false}} {
		p := dir + "/" + tc.name
		if err := writeFile(p, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: tc.der}))); err != nil {
			t.Fatal(err)
		}
		got, err := LoadKey(p)
		if (err == nil) != tc.ok || (tc.ok && !got.Equal(k)) {
			t.Errorf("%s: err=%v", tc.name, err)
		}
	}
	// a supplied key is the one that signs: its kid is in the JWKS
	deps, _, _ := newDeps()
	deps.Key = k
	_, base := v1Server(t, deps, testToken)
	resp, err := http.Get(base + jwksPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	pub, err := k.PublicKey.Bytes() // 0x04 || X || Y
	if err != nil {
		t.Fatal(err)
	}
	var set struct{ Keys []struct{ X string } }
	_ = json.NewDecoder(resp.Body).Decode(&set)
	if len(set.Keys) != 1 || set.Keys[0].X != base64.RawURLEncoding.EncodeToString(pub[1:33]) {
		t.Errorf("jwks = %+v does not hold the supplied key", set)
	}
}
