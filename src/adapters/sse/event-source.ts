// EventSourcePort over server-sent events with a bearer token. The browser EventSource cannot
// send a header, so this reads the stream with fetch and resumes with Last-Event-ID.
import type { EventSourcePort, SourceEvent } from "../../ports/event-source";

export class SseEventSource implements EventSourcePort {
  constructor(
    private readonly url: string,
    private readonly token: () => string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async follow(after: number, onEvent: (e: SourceEvent) => Promise<void> | void, signal?: AbortSignal) {
    const res = await this.doFetch(this.url, {
      signal,
      headers: { authorization: `Bearer ${this.token()}`, accept: "text/event-stream", "last-event-id": String(after) },
    });
    if (!res.ok || !res.body) throw new Error(`event stream refused: HTTP ${res.status}`);
    let last = after;
    let buf = "";
    let frame: { id?: number; type?: string; data: string[] } = { data: [] };
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (line === "") {
            if (frame.id !== undefined && frame.id > last && frame.data.length > 0) {
              last = frame.id;
              await onEvent({ seq: frame.id, type: frame.type ?? "message", data: JSON.parse(frame.data.join("\n")) });
            }
            frame = { data: [] };
          } else if (line.startsWith("id:")) frame.id = Number(line.slice(3).trim());
          else if (line.startsWith("event:")) frame.type = line.slice(6).trim();
          else if (line.startsWith("data:")) frame.data.push(line.slice(5).trimStart());
        }
      }
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
    return last;
  }
}
