// kaas-relay: carries the factory's cockpit state to a phone that cannot reach the dashboard. The
// factory publishes one JSON line per channel with the publish token; subscribers read it as
// server-sent events with a separate, read-only token. It keeps only the last line per channel, so
// a phone that opens late sees the current state at once. Nothing travels back: approvals stay on
// GitHub or the dashboard. Std only, so there is no dependency to vet or patch.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const MAX_BODY: usize = 64 * 1024;
const MAX_LINE: usize = 8 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_SUBSCRIBERS: usize = 32;
const HEARTBEAT: Duration = Duration::from_secs(15);
// A subscriber that stops reading holds the hub lock for at most this long, then is dropped.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Channel {
    last: Option<String>,
    subscribers: Vec<TcpStream>,
}

type Hub = Arc<Mutex<HashMap<String, Channel>>>;

struct Tokens {
    publish: String,
    subscribe: String,
}

struct Request {
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn main() -> ExitCode {
    let publish = std::env::var("KAAS_RELAY_PUBLISH_TOKEN").unwrap_or_default();
    let subscribe = std::env::var("KAAS_RELAY_SUBSCRIBE_TOKEN").unwrap_or_default();
    if publish.len() < 16 || subscribe.len() < 16 || publish == subscribe {
        eprintln!("kaas-relay: set KAAS_RELAY_PUBLISH_TOKEN and KAAS_RELAY_SUBSCRIBE_TOKEN, each at least 16 characters and different");
        return ExitCode::from(2);
    }
    let addr = std::env::var("KAAS_RELAY_ADDR").unwrap_or_else(|_| "127.0.0.1:4200".into());
    let listener = match TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("kaas-relay: cannot listen on {addr}: {e}");
            return ExitCode::from(1);
        }
    };
    match listener.local_addr() {
        Ok(a) => println!("kaas-relay listening on {a}"),
        Err(_) => println!("kaas-relay listening on {addr}"),
    }
    let tokens = Arc::new(Tokens { publish, subscribe });
    let hub: Hub = Arc::default();
    let beat = Arc::clone(&hub);
    thread::spawn(move || loop {
        thread::sleep(HEARTBEAT);
        broadcast(&beat, None, ": ping\n\n");
    });
    for stream in listener.incoming().flatten() {
        let (hub, tokens) = (Arc::clone(&hub), Arc::clone(&tokens));
        thread::spawn(move || handle(stream, &hub, &tokens));
    }
    ExitCode::SUCCESS
}

// Writes one frame to a channel (or every channel), dropping each subscriber whose write fails.
fn broadcast(hub: &Hub, channel: Option<&str>, frame: &str) -> usize {
    let mut hub = hub.lock().unwrap_or_else(|e| e.into_inner());
    let mut delivered = 0;
    for (name, ch) in hub.iter_mut() {
        if channel.is_some_and(|c| c != name) {
            continue;
        }
        ch.subscribers.retain_mut(|s| {
            s.write_all(frame.as_bytes())
                .and_then(|()| s.flush())
                .is_ok()
        });
        delivered += ch.subscribers.len();
    }
    delivered
}

fn handle(mut stream: TcpStream, hub: &Hub, tokens: &Tokens) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let req = match read_request(&stream) {
        Ok(r) => r,
        Err((status, why)) => {
            respond(&mut stream, status, why);
            // Read what the client is still sending, so closing does not reset the reply away.
            let _ = stream.shutdown(Shutdown::Write);
            let _ = std::io::copy(
                &mut (&stream).take(4 * MAX_BODY as u64),
                &mut std::io::sink(),
            );
            return;
        }
    };
    let route = req.path.split('/').collect::<Vec<_>>();
    match (req.method.as_str(), route.as_slice()) {
        ("OPTIONS", _) => respond(&mut stream, 204, ""),
        ("GET", ["", "healthz"]) => respond(&mut stream, 200, "ok"),
        ("POST", ["", "publish", channel]) => publish(&mut stream, hub, tokens, &req, channel),
        ("GET", ["", "subscribe", channel]) => subscribe(stream, hub, tokens, &req, channel),
        _ => respond(&mut stream, 404, "not found"),
    }
}

fn publish(stream: &mut TcpStream, hub: &Hub, tokens: &Tokens, req: &Request, channel: &str) {
    if !same(bearer(req).unwrap_or(""), &tokens.publish) {
        return respond(stream, 401, "publish token required");
    }
    if !valid_channel(channel) {
        return respond(stream, 400, "channel is 1-64 of a-z, 0-9 and -");
    }
    // One event is one line: SSE splits on newlines, so a multi-line body would arrive torn.
    let Ok(line) = std::str::from_utf8(&req.body) else {
        return respond(stream, 400, "body must be UTF-8");
    };
    if line.is_empty() || line.contains(['\n', '\r']) {
        return respond(stream, 400, "body must be one non-empty line");
    }
    let frame = format!("data: {line}\n\n");
    hub.lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(channel.to_string())
        .or_default()
        .last = Some(frame.clone());
    let delivered = broadcast(hub, Some(channel), &frame);
    respond(stream, 202, &format!("{{\"delivered\":{delivered}}}"));
}

fn subscribe(mut stream: TcpStream, hub: &Hub, tokens: &Tokens, req: &Request, channel: &str) {
    // EventSource cannot set headers, so the read-only token may also come as ?token=.
    let token = bearer(req).or_else(|| {
        req.query
            .split('&')
            .find_map(|kv| kv.strip_prefix("token="))
    });
    if !same(token.unwrap_or(""), &tokens.subscribe) {
        return respond(&mut stream, 401, "subscribe token required");
    }
    if !valid_channel(channel) {
        return respond(&mut stream, 400, "channel is 1-64 of a-z, 0-9 and -");
    }
    let mut hub = hub.lock().unwrap_or_else(|e| e.into_inner());
    let ch = hub.entry(channel.to_string()).or_default();
    if ch.subscribers.len() >= MAX_SUBSCRIBERS {
        drop(hub);
        return respond(&mut stream, 503, "too many subscribers on this channel");
    }
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\naccess-control-allow-origin: *\r\nconnection: keep-alive\r\n\r\n";
    let opened = stream
        .write_all(head.as_bytes())
        .and_then(|()| match &ch.last {
            Some(frame) => stream.write_all(frame.as_bytes()),
            None => stream.write_all(b": open\n\n"),
        });
    if opened.and_then(|()| stream.flush()).is_ok() {
        ch.subscribers.push(stream);
    }
}

fn read_request(stream: &TcpStream) -> Result<Request, (u16, &'static str)> {
    let mut reader = BufReader::new(stream);
    let line = read_line(&mut reader)?;
    let mut parts = line.split(' ');
    let (method, target) = match (parts.next(), parts.next()) {
        (Some(m), Some(t)) if !m.is_empty() && t.starts_with('/') => (m.to_string(), t),
        _ => return Err((400, "bad request line")),
    };
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut headers: HashMap<String, String> = HashMap::new();
    for _ in 0..=MAX_HEADERS {
        let header = read_line(&mut reader)?;
        if header.is_empty() {
            let length = match headers.get("content-length") {
                None => 0,
                Some(v) => v
                    .parse::<usize>()
                    .map_err(|_| (400, "bad content-length"))?,
            };
            if length > MAX_BODY {
                return Err((413, "body over 64 KiB"));
            }
            let mut body = vec![0; length];
            reader
                .read_exact(&mut body)
                .map_err(|_| (400, "body shorter than content-length"))?;
            return Ok(Request {
                method,
                path: path.to_string(),
                query: query.to_string(),
                headers,
                body,
            });
        }
        if let Some((k, v)) = header.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    Err((431, "too many headers"))
}

fn read_line(reader: &mut BufReader<&TcpStream>) -> Result<String, (u16, &'static str)> {
    let mut buf = Vec::new();
    reader
        .by_ref()
        .take(MAX_LINE as u64 + 1)
        .read_until(b'\n', &mut buf)
        .map_err(|_| (408, "read timed out"))?;
    if buf.len() > MAX_LINE {
        return Err((431, "line too long"));
    }
    let text = String::from_utf8(buf).map_err(|_| (400, "request is not UTF-8"))?;
    Ok(text.trim_end_matches(['\r', '\n']).to_string())
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "Service Unavailable",
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/plain\r\ncontent-length: {}\r\naccess-control-allow-origin: *\r\naccess-control-allow-headers: authorization, content-type\r\naccess-control-allow-methods: GET, POST, OPTIONS\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn bearer(req: &Request) -> Option<&str> {
    req.headers.get("authorization")?.strip_prefix("Bearer ")
}

fn valid_channel(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

// Compares every byte whatever the first mismatch, so timing does not leak how much of a token matched.
fn same(given: &str, want: &str) -> bool {
    given.len() == want.len()
        && given
            .bytes()
            .zip(want.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}
