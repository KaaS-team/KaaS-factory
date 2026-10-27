// A path-style S3 endpoint in memory: PUT, GET, HEAD, DELETE and ListObjectsV2, the calls the adapters make.
export function fakeS3() {
  const objects = new Map<string, Uint8Array>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      if (bucket !== "factory") return new Response("NoSuchBucket", { status: 404 });
      if (req.method === "PUT") {
        objects.set(key, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 200, headers: { etag: '"1"' } });
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (!key && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const rows = [...objects]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`)
          .join("");
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>factory</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${rows}</ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      const body = objects.get(key);
      if (!body) return new Response(req.method === "HEAD" ? null : "NoSuchKey", { status: 404 });
      const headers = { "content-length": String(body.length), etag: '"1"' };
      return new Response(req.method === "HEAD" ? null : body, { headers });
    },
  });
  return { server, objects };
}
