package audit

import (
	"context"
	"os"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	otellog "go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
)

// OTLP sends records to an OTLP/HTTP collector as OpenTelemetry log records.
type OTLP struct{ p *sdklog.LoggerProvider }

// NewOTLPFromEnv returns an exporter when OTEL_EXPORTER_OTLP_ENDPOINT is set, and nil otherwise.
// The standard OTEL_EXPORTER_OTLP_* variables (headers, timeout) apply.
func NewOTLPFromEnv(ctx context.Context) (*OTLP, error) {
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" && os.Getenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") == "" {
		return nil, nil
	}
	exp, err := otlploghttp.New(ctx)
	if err != nil {
		return nil, err
	}
	return &OTLP{p: sdklog.NewLoggerProvider(sdklog.WithProcessor(sdklog.NewBatchProcessor(exp)))}, nil
}

// Write queues r for export.
func (o *OTLP) Write(ctx context.Context, r Entry) error {
	var rec otellog.Record
	rec.SetTimestamp(r.Timestamp)
	rec.SetObservedTimestamp(r.Timestamp)
	rec.SetSeverityText(r.SeverityText)
	rec.SetSeverity(otellog.SeverityInfo)
	if r.SeverityText == "ERROR" {
		rec.SetSeverity(otellog.SeverityError)
	}
	rec.SetBody(attribute.StringValue(r.Body))
	for k, v := range r.Attributes {
		rec.AddAttributes(attribute.String(k, v))
	}
	o.p.Logger("kaas-factory/audit").Emit(ctx, rec)
	return nil
}

// Close flushes queued records and stops the exporter.
func (o *OTLP) Close(ctx context.Context) error { return o.p.Shutdown(ctx) }
