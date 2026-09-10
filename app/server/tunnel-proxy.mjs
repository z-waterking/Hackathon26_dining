import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, request } from "node:http";

// Monthly planning runs several AI calls sequentially; bound the whole workflow.
const upstreamDeadlineMs = 40 * 60_000;
const hopByHopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "http2-settings",
]);
const privateRequestHeaders = new Set([
  "authorization", "cookie", "expect", "forwarded", "host", "origin",
  "referer", "via", "x-real-ip", "true-client-ip", "x-original-host",
  "x-original-url", "x-rewrite-url",
]);
const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function occurrences(message, name) {
  let count = 0;
  for (let index = 0; index < message.rawHeaders.length; index += 2)
    if (message.rawHeaders[index].toLowerCase() === name) count += 1;
  return count;
}

function canonicalPublicOrigin(value) {
  if (typeof value !== "string") return null;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.origin !== value
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.]trycloudflare[.]com$/.test(parsed.hostname))
    return null;
  return parsed;
}

function validTarget(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    && !value.includes(String.fromCharCode(92)) && !value.includes("#")
    && !Array.from(value).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127);
}

function connectionHeaders(headers) {
  return new Set(String(headers.connection || "").toLowerCase().split(",").map((name) => name.trim()));
}

function upstreamHeaders(incoming, upstream) {
  const nominated = connectionHeaders(incoming);
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (hopByHopHeaders.has(name) || nominated.has(name) || privateRequestHeaders.has(name)
      || name.startsWith("x-forwarded-") || name.startsWith("cf-")) continue;
    headers[name] = value;
  }
  // Synthesize these last, even if Connection nominated them for removal.
  headers.host = upstream.host;
  headers.origin = upstream.origin;
  return headers;
}

function downstreamHeaders(incoming, upstream, publicOrigin, requestPath) {
  const nominated = connectionHeaders(incoming);
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (hopByHopHeaders.has(name) || nominated.has(name)
      || ["set-cookie", "www-authenticate", "refresh"].includes(name)
      || name.startsWith("access-control-")) continue;
    headers[name] = value;
  }
  if (headers.location !== undefined) {
    // Never follow redirects, or send a browser (and cached credentials) to another origin.
    const target = new URL(headers.location, `${upstream.origin}${requestPath}`);
    if (target.username || target.password
      || ![upstream.origin, publicOrigin].includes(target.origin))
      throw new Error("Unsupported upstream redirect");
    headers.location = `${publicOrigin}${target.pathname}${target.search}${target.hash}`;
  }
  headers["cache-control"] = "no-store";
  headers["referrer-policy"] = "no-referrer";
  headers["x-content-type-options"] = "nosniff";
  return headers;
}

function denial(status, message, headers = {}) {
  return { status, message: `${message}\n`, headers: { ...responseHeaders, connection: "close", ...headers } };
}

function reply(response, denied) {
  response.writeHead(denied.status, {
    ...denied.headers, "content-length": Buffer.byteLength(denied.message),
  });
  response.end(denied.message);
}

/**
 * A gateway for one discovered Cloudflare Quick Tunnel. The caller must bind
 * it to loopback. Anonymous access requires explicit authentication: "none".
 */
export function createTunnelProxy({ upstreamUrl, username, password, getPublicOrigin, authentication = "basic" }) {
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)
    || upstream.username || upstream.password || upstream.pathname !== "/"
    || upstream.search || upstream.hash)
    throw new Error("Tunnel upstream must be an HTTP loopback origin.");
  if (!["basic", "none"].includes(authentication))
    throw new Error("Tunnel authentication must be basic or none.");
  if (typeof getPublicOrigin !== "function")
    throw new Error("Tunnel public-origin callback is required.");
  if (authentication === "basic" && (typeof username !== "string" || !username || username.length > 256
    || /[:\r\n]/.test(username) || typeof password !== "string" || !password
    || password.length > 4096 || /[\r\n]/.test(password)))
    throw new Error("Tunnel credentials and public-origin callback are required.");
  const expectedDigest = authentication === "basic"
    ? createHash("sha256").update(`${username}:${password}`, "utf8").digest() : null;

  function authenticated(incoming) {
    const value = incoming.headers.authorization;
    if (occurrences(incoming, "authorization") !== 1 || typeof value !== "string"
      || value.length > 8192) return false;
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(value);
    if (!match) return false;
    const candidate = Buffer.from(match[1], "base64");
    if (candidate.toString("base64") !== match[1]) return false;
    return timingSafeEqual(createHash("sha256").update(candidate).digest(), expectedDigest);
  }

  function validate(incoming) {
    let publicUrl;
    try { publicUrl = canonicalPublicOrigin(getPublicOrigin()); } catch { /* Fail closed while configuring. */ }
    if (!publicUrl) return denial(503, "Tunnel is not ready.");
    if (occurrences(incoming, "host") !== 1 || incoming.headers.host !== publicUrl.host)
      return denial(403, "Forbidden host.");
    // Only use forwarding metadata to reject HTTP, never to select a trusted host.
    let httpEntry = incoming.headers["x-forwarded-proto"] === "http";
    const forwardedProtocol = incoming.headers["x-forwarded-proto"];
    if (forwardedProtocol !== undefined && (occurrences(incoming, "x-forwarded-proto") !== 1
      || !["http", "https"].includes(forwardedProtocol)))
      return denial(403, "Forbidden transport.");
    const visitor = incoming.headers["cf-visitor"];
    if (visitor !== undefined) {
      try {
        const scheme = JSON.parse(visitor).scheme;
        if (occurrences(incoming, "cf-visitor") !== 1 || !["http", "https"].includes(scheme))
          return denial(403, "Forbidden transport.");
        httpEntry ||= scheme === "http";
      } catch { return denial(403, "Forbidden transport."); }
    }
    if (httpEntry) {
      if (!["GET", "HEAD"].includes(incoming.method))
        return denial(403, "HTTPS is required.");
      if (!validTarget(incoming.url))
        return denial(400, "Unsupported request target.");
      return denial(308, "HTTPS is required.", { location: `${publicUrl.origin}${incoming.url}` });
    }
    if (authentication === "basic" && !authenticated(incoming))
      return denial(401, "Authentication required.", {
        "www-authenticate": 'Basic realm="Dining", charset="UTF-8"',
      });
    // Origin-form paths only. The upstream destination never comes from a request target.
    if (!validTarget(incoming.url))
      return denial(400, "Unsupported request target.");
    const origin = incoming.headers.origin;
    const site = incoming.headers["sec-fetch-site"];
    const safe = ["GET", "HEAD"].includes(incoming.method);
    if (origin !== undefined && (occurrences(incoming, "origin") !== 1 || origin !== publicUrl.origin))
      return denial(403, "Forbidden origin.");
    if (site !== undefined && !["same-origin", "same-site", "cross-site", "none"].includes(site))
      return denial(403, "Forbidden request context.");
    if (["same-site", "cross-site"].includes(site)
      && !(safe && incoming.headers["sec-fetch-mode"] === "navigate"
        && incoming.headers["sec-fetch-dest"] === "document"))
      return denial(403, "Forbidden request context.");
    // CLI clients may omit Origin; browser mutation requests must provide it.
    if (!safe && origin === undefined
      && ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer"]
        .some((name) => incoming.headers[name] !== undefined))
      return denial(403, "Origin required.");
    if (["CONNECT", "TRACE"].includes(incoming.method))
      return denial(405, "Unsupported method.");
    return { publicOrigin: publicUrl.origin };
  }

  function proxy(incoming, outgoing) {
    const result = validate(incoming);
    if (result.status) {
      incoming.resume();
      reply(outgoing, result);
      return;
    }
    if (incoming.headers.expect !== undefined) {
      if (incoming.headers.expect.toLowerCase() !== "100-continue") {
        incoming.resume();
        reply(outgoing, denial(417, "Unsupported expectation."));
        return;
      }
      outgoing.writeContinue();
    }
    let upstreamRequest;
    let upstreamResponse;
    let finished = false;
    const deadline = setTimeout(() => fail(504, "Upstream request timed out."), upstreamDeadlineMs);
    deadline.unref();

    function stop() {
      clearTimeout(deadline);
      if (upstreamRequest) incoming.unpipe(upstreamRequest);
      upstreamResponse?.destroy();
      upstreamRequest?.destroy();
    }
    function fail(status, message) {
      if (finished) return;
      finished = true;
      stop();
      incoming.resume();
      if (outgoing.headersSent) outgoing.destroy();
      else if (!outgoing.destroyed) reply(outgoing, denial(status, message));
    }
    outgoing.once("finish", () => { finished = true; clearTimeout(deadline); });
    outgoing.once("close", () => { finished = true; stop(); });
    incoming.once("aborted", () => { finished = true; stop(); outgoing.destroy(); });
    incoming.once("error", () => fail(400, "Request interrupted."));
    try {
      upstreamRequest = request({
        protocol: "http:",
        hostname: upstream.hostname.replace(/^\[|\]$/g, ""),
        port: upstream.port || 80,
        method: incoming.method,
        path: incoming.url,
        headers: upstreamHeaders(incoming.headers, upstream),
        agent: false,
      }, (response) => {
        upstreamResponse = response;
        if (finished) { response.destroy(); return; }
        response.once("aborted", () => fail(502, "Upstream response interrupted."));
        response.once("error", () => fail(502, "Upstream response interrupted."));
        try {
          outgoing.writeHead(response.statusCode, downstreamHeaders(response.headers, upstream, result.publicOrigin, incoming.url));
          response.pipe(outgoing);
        } catch { fail(502, "Invalid upstream response."); }
      });
      upstreamRequest.once("error", () => fail(502, "Upstream unavailable."));
      incoming.pipe(upstreamRequest);
    } catch { fail(502, "Upstream unavailable."); }
  }

  const server = createServer({ maxHeaderSize: 16_384 }, proxy);
  server.headersTimeout = 15_000;
  server.requestTimeout = 200_000;
  server.timeout = upstreamDeadlineMs + 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  server.on("checkContinue", proxy);
  server.on("checkExpectation", proxy);
  function rejectProtocol(incoming, socket) {
    const result = validate(incoming);
    const rejected = result.status ? result : denial(405, "Protocol upgrades are not supported.");
    if (!socket.writable) return;
    const headers = Object.entries({ ...rejected.headers, "content-length": Buffer.byteLength(rejected.message) })
      .map(([name, value]) => `${name}: ${value}`).join("\r\n");
    socket.end(`HTTP/1.1 ${rejected.status} Rejected\r\n${headers}\r\n\r\n${rejected.message}`);
  }
  server.on("upgrade", rejectProtocol);
  server.on("connect", rejectProtocol);
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });
  return server;
}
