// Package egress is the one door out of a sandboxed session: an allow/deny
// proxy that holds the real credentials, plus a masker for output.
//
// The session's environment carries placeholders only (Secrets.Env gives a
// secret's placeholder only when the command names it). Proxy resolves a
// placeholder in a request header when, and only when, the request goes over
// TLS to a host that secret lists. Anything else that mentions a placeholder is
// refused whole, so nothing is forwarded and no value is echoed:
//
//   - a placeholder for a secret that is unknown or not listed for the host;
//   - a placeholder in a URL, or in a request sent over cleartext http;
//   - a destination the Network rules deny, by name or by any resolved address.
//
// A host with no secret rule is tunnelled untouched, so a placeholder sent
// there stays literal text. Request bodies are not rewritten.
//
// NewSecrets is the gate: a wildcard host with fewer suffix labels than the
// configured depth ("*.com") is rejected before the session starts.
//
// Design verdict on a VM backend: no-go for now. The secret boundary is the
// proxy living outside the session, which holds under the current jail as long
// as the jail refuses every outbound connection except to the proxy port
// (Landlock ABI 4 can restrict TCP connect by port; that wiring is not here).
// A VM would add a second boundary at the cost of a daemon, an image and guest
// networking, none of which this needs yet. Revisit if a host cannot restrict
// connect by port.
package egress
