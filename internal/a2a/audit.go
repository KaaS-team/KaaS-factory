package a2a

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"time"

	sdk "github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
)

// AuditRow is one served call: when, which method, which task it touched and how it ended.
// It holds no message text.
type AuditRow struct {
	At     time.Time `json:"at"`
	Method string    `json:"method"`
	Task   string    `json:"task,omitempty"`
	Error  string    `json:"error,omitempty"`
}

// Auditor receives one row per call.
type Auditor interface {
	Record(ctx context.Context, row AuditRow) error
}

// JSONLAuditor writes each row as one JSON line to W.
type JSONLAuditor struct {
	mu sync.Mutex
	W  io.Writer
}

// Record appends row to W.
func (a *JSONLAuditor) Record(_ context.Context, row AuditRow) error {
	b, err := json.Marshal(row)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, err = a.W.Write(append(b, '\n'))
	return err
}

// auditor is the call interceptor that writes the audit row. A streaming call has many responses;
// its row is written at the first one, which carries the task and any early error.
type auditor struct {
	sink Auditor
}

type auditKey struct{}

var _ a2asrv.CallInterceptor = (*auditor)(nil)

func (*auditor) Before(ctx context.Context, _ *a2asrv.CallContext, _ *a2asrv.Request) (context.Context, any, error) {
	return context.WithValue(ctx, auditKey{}, new(sync.Once)), nil, nil
}

// After records the call. A sink failure refuses the call, so no call goes unrecorded.
func (a *auditor) After(ctx context.Context, cc *a2asrv.CallContext, resp *a2asrv.Response) error {
	once, ok := ctx.Value(auditKey{}).(*sync.Once)
	if !ok {
		return nil
	}
	var err error
	once.Do(func() {
		row := AuditRow{At: time.Now().UTC(), Method: cc.Method(), Task: taskOf(resp.Payload)}
		if resp.Err != nil {
			row.Error = resp.Err.Error()
		}
		err = a.sink.Record(ctx, row)
	})
	return err
}

// taskOf is the task id a response names, or "".
func taskOf(payload any) string {
	switch v := payload.(type) {
	case *sdk.Task:
		if v == nil { // a failed unary call carries a typed nil
			return ""
		}
		return string(v.ID)
	case sdk.Event:
		return string(v.TaskInfo().TaskID)
	}
	return ""
}
