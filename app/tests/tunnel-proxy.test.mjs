import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { createTunnelProxy } from "../server/tunnel-proxy.mjs";

const publicOrigin = "https://synthetic-dining-test.trycloudflare.com";
const publicHost = new URL(publicOrigin).host;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function setup(t, handler, proxyOptions = {}) {
  const requests = [];
  const upstream = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const captured = { method: incoming.method, path: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks) };
    requests.push(captured);
    if (handler) handler(captured, outgoing);
    else {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ ok: true, path: incoming.url }));
    }
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const username = "test-user";
  const password = randomBytes(24).toString("base64url");
  let configuredOrigin = publicOrigin;
  const proxy = createTunnelProxy({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    username, password, getPublicOrigin: () => configuredOrigin,
    ...proxyOptions,
  });
  const port = await listen(proxy);
  t.after(() => close(proxy));
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  return {
    proxy, port, upstreamPort, requests, authorization,
    configure: (value) => { configuredOrigin = value; },
    send: (options = {}) => send(port, { ...options,
      // Always include the canonical Host unless explicitly overridden.
      headers: { host: publicHost, ...options.headers },
    }),
  };
}

function send(port, { method = "GET", path = "/api/data", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, method, path, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.once("error", reject);
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error("Synthetic request timed out")));
    outgoing.end(body);
  });
}

function sendRaw(port, lines) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = connect(port, "127.0.0.1", () => socket.end(`${lines.join("\r\n")}\r\n\r\n`));
    socket.setTimeout(3000, () => socket.destroy(new Error("Synthetic socket timed out")));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("tunnel denies all paths until a canonical public origin is configured", async (t) => {
  const fixture = await setup(t);
  for (const origin of [null, undefined, "https://other.example", `${publicOrigin}/`,
    "http://synthetic-dining-test.trycloudflare.com", `${publicOrigin}:443`,
    "https://user@synthetic-dining-test.trycloudflare.com"]) {
    fixture.configure(origin);
    const response = await fixture.send({ headers: { authorization: fixture.authorization } });
    assert.equal(response.status, 503);
    assert.equal(response.headers["www-authenticate"], undefined);
  }
  assert.equal(fixture.requests.length, 0);
});

test("tunnel authenticates health, static files, data, and downloads before upstream access", async (t) => {
  const fixture = await setup(t);
  for (const path of ["/", "/assets/app.js", "/api/health", "/api/data", "/api/export/menus"]) {
    const response = await fixture.send({ path });
    assert.equal(response.status, 401, path);
    assert.equal(response.headers["www-authenticate"], 'Basic realm="Dining", charset="UTF-8"');
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.body.toString(), "Authentication required.\n");
  }
  assert.equal(fixture.requests.length, 0);
});

test("explicit anonymous mode serves pages, health, and API reads without credentials", async (t) => {
  const fixture = await setup(t, undefined, { authentication: "none", username: undefined, password: undefined });
  for (const path of ["/", "/api/health", "/api/data"]) {
    const response = await fixture.send({ path });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers["www-authenticate"], undefined);
    assert.deepEqual(JSON.parse(response.body), { ok: true, path });
  }
  assert.equal(fixture.requests.length, 3);
  for (const incoming of fixture.requests) assert.equal(incoming.headers.authorization, undefined);
});

test("anonymous same-origin writes preserve JSON and binary uploads", async (t) => {
  const fixture = await setup(t, undefined, { authentication: "none", username: undefined, password: undefined });
  const samples = [
    { path: "/api/feedback", type: "application/json", body: Buffer.from(JSON.stringify({ content: "synthetic test" })) },
    { path: "/api/feedback/upload", type: "application/octet-stream", body: Buffer.concat([Buffer.from([0, 255, 13, 10, 128]), randomBytes(4096)]) },
  ];
  for (const sample of samples) {
    const response = await fixture.send({ method: "POST", path: sample.path, headers: {
      origin: publicOrigin, "sec-fetch-site": "same-origin",
      "content-type": sample.type, "content-length": sample.body.length,
    }, body: sample.body });
    assert.equal(response.status, 200);
    assert.equal(response.headers["www-authenticate"], undefined);
    const incoming = fixture.requests.at(-1);
    assert.deepEqual(incoming.body, sample.body);
    assert.equal(incoming.headers["content-type"], sample.type);
    assert.equal(incoming.headers.origin, `http://127.0.0.1:${fixture.upstreamPort}`);
    assert.equal(incoming.headers.authorization, undefined);
  }
  assert.equal(fixture.requests.length, 2);
});

test("anonymous mode retains exact Host, origin, browser context, and HTTPS checks", async (t) => {
  const fixture = await setup(t, undefined, { authentication: "none", username: undefined, password: undefined });
  for (const options of [
    { headers: { host: "attacker.example", "x-forwarded-host": publicHost } },
    { headers: { host: `${publicHost}:443` } },
    { headers: { origin: "https://attacker.example" } },
    { method: "POST", headers: { origin: "https://attacker.example" } },
    { method: "POST", headers: { origin: publicOrigin, "sec-fetch-site": "cross-site" } },
    { method: "POST", headers: { "sec-fetch-site": "same-origin" } },
    { method: "POST", headers: { origin: publicOrigin, "x-forwarded-proto": "http" } },
  ]) {
    const response = await fixture.send(options);
    assert.equal(response.status, 403);
    assert.equal(response.headers["www-authenticate"], undefined);
  }
  assert.equal(fixture.requests.length, 0);
});

test("tunnel rejects incorrect, malformed and duplicate Basic credentials", async (t) => {
  const fixture = await setup(t);
  for (const authorization of ["Bearer anything", "Basic ???", "Basic Zg",
    `Basic ${Buffer.from(`other:${randomBytes(12).toString("hex")}`).toString("base64")}`,
    [fixture.authorization, fixture.authorization]]) {
    assert.equal((await fixture.send({ headers: { authorization } })).status, 401);
  }
  assert.equal(fixture.requests.length, 0);
});

test("Host must exactly match the tunnel; forwarding headers cannot bypass validation", async (t) => {
  const fixture = await setup(t);
  for (const host of ["127.0.0.1", "attacker.example", `${publicHost}.attacker.example`,
    `${publicHost}:443`, publicHost.toUpperCase(), `${publicHost}, attacker.example`]) {
    const response = await fixture.send({ headers: {
      host, authorization: fixture.authorization, "x-forwarded-host": publicHost,
      forwarded: `host=${publicHost};proto=https`,
    } });
    assert.equal(response.status, 403, host);
  }
  const duplicate = await sendRaw(fixture.port, [
    "GET /api/data HTTP/1.1", `Host: ${publicHost}`, `Host: ${publicHost}`,
    `Authorization: ${fixture.authorization}`,
  ]);
  assert.ok(duplicate.startsWith("HTTP/1.1 403 "));
  assert.equal(fixture.requests.length, 0);
});

test("plaintext tunnel entry redirects reads to exact HTTPS without an auth challenge and rejects writes", async (t) => {
  const fixture = await setup(t);
  for (const metadata of [{ "x-forwarded-proto": "http" }, { "cf-visitor": '{"scheme":"http"}' }]) {
    const response = await fixture.send({ path: "/api/data?format=json", headers: { ...metadata, "x-forwarded-host": "attacker.example" } });
    assert.equal(response.status, 308);
    assert.equal(response.headers.location, `${publicOrigin}/api/data?format=json`);
    assert.equal(response.headers["www-authenticate"], undefined);
    const write = await fixture.send({ method: "POST", headers: { ...metadata, authorization: fixture.authorization } });
    assert.equal(write.status, 403);
    assert.equal(write.headers["www-authenticate"], undefined);
  }
  for (const metadata of [{ "x-forwarded-proto": "https, http" }, { "cf-visitor": "invalid" },
    { "cf-visitor": '{"scheme":"ftp"}' }]) {
    assert.equal((await fixture.send({ headers: { ...metadata, authorization: fixture.authorization } })).status, 403);
  }
  assert.equal(fixture.requests.length, 0);
});

test("tunnel rejects unsafe browser origins and cross-site requests without reaching upstream", async (t) => {
  const fixture = await setup(t);
  for (const origin of ["null", "https://attacker.example", "https://another.trycloudflare.com",
    publicOrigin.replace("https:", "http:"), `${publicOrigin}/`, `${publicOrigin}:443`,
    [publicOrigin, publicOrigin]]) {
    const response = await fixture.send({ method: "POST", headers: { authorization: fixture.authorization, origin } });
    assert.equal(response.status, 403);
  }
  for (const metadata of [
    { origin: publicOrigin, "sec-fetch-site": "cross-site" },
    { origin: publicOrigin, "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "same-origin" },
    { referer: `${publicOrigin}/` },
    { "sec-fetch-mode": "cors" },
  ]) {
    assert.equal((await fixture.send({ method: "POST", headers: { authorization: fixture.authorization, ...metadata } })).status, 403);
  }
  assert.equal((await fixture.send({ headers: { authorization: fixture.authorization, "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } })).status, 403);
  assert.equal(fixture.requests.length, 0);
});

test("authenticated GETs and normal top-level links work with rewritten trusted headers", async (t) => {
  const fixture = await setup(t);
  const response = await fixture.send({ path: "/api/health?probe=1", headers: {
    authorization: fixture.authorization, origin: publicOrigin, cookie: "untrusted=value",
    "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https",
    "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "203.0.113.9",
    forwarded: "host=attacker.example;proto=http",
    connection: "host, origin, authorization, x-strip-me", "x-strip-me": "untrusted",
    referer: "https://attacker.example/",
  } });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(response.body), { ok: true, path: "/api/health?probe=1" });
  const forwarded = fixture.requests[0];
  assert.equal(forwarded.headers.host, `127.0.0.1:${fixture.upstreamPort}`);
  assert.equal(forwarded.headers.origin, `http://127.0.0.1:${fixture.upstreamPort}`);
  for (const name of ["authorization", "cookie", "forwarded", "referer", "x-forwarded-host",
    "x-forwarded-for", "x-forwarded-proto", "cf-connecting-ip", "x-strip-me"])
    assert.equal(forwarded.headers[name], undefined, name);
  assert.equal((await fixture.send({ path: "/", headers: { authorization: fixture.authorization,
    "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } })).status, 200);
});

test("same-origin browser writes and authenticated CLI writes preserve JSON and binary uploads", async (t) => {
  const fixture = await setup(t);
  const json = Buffer.from(JSON.stringify({ content: "synthetic test" }));
  assert.equal((await fixture.send({ method: "POST", path: "/api/feedback",
    headers: { authorization: fixture.authorization, origin: publicOrigin, "sec-fetch-site": "same-origin",
      "content-type": "application/json", "content-length": json.length }, body: json })).status, 200);
  assert.deepEqual(fixture.requests[0].body, json);
  assert.equal(fixture.requests[0].headers["content-type"], "application/json");

  const bytes = Buffer.concat([Buffer.from([0, 255, 13, 10, 128]), randomBytes(96 * 1024)]);
  assert.equal((await fixture.send({ method: "POST", path: "/api/feedback/upload",
    headers: { authorization: fixture.authorization, "content-type": "application/octet-stream",
      "x-file-name": "synthetic.xlsx", "content-length": bytes.length }, body: bytes })).status, 200);
  assert.deepEqual(fixture.requests[1].body, bytes);
  assert.equal(fixture.requests[1].headers["content-type"], "application/octet-stream");
  assert.equal(fixture.requests[1].headers["x-file-name"], "synthetic.xlsx");
});

test("downloads stream without corruption and omit upstream cookies and permissive CORS", async (t) => {
  const bytes = randomBytes(130 * 1024);
  const fixture = await setup(t, (_incoming, outgoing) => {
    outgoing.writeHead(200, {
      "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="synthetic.xlsx"',
      "content-length": bytes.length, "set-cookie": "secret=value",
      "access-control-allow-origin": "*", "cache-control": "public, max-age=3600",
    });
    outgoing.write(bytes.subarray(0, 70_000));
    setTimeout(() => outgoing.end(bytes.subarray(70_000)), 15);
  });
  const response = await fixture.send({ path: "/api/export/menus", headers: { authorization: fixture.authorization } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, bytes);
  assert.equal(response.headers["content-disposition"], 'attachment; filename="synthetic.xlsx"');
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("request targets cannot select another upstream or use unsupported protocols", async (t) => {
  const fixture = await setup(t);
  for (const path of ["http://127.0.0.1:1/private", "//attacker.example/private", "/\\attacker.example"]) {
    assert.equal((await fixture.send({ path, headers: { authorization: fixture.authorization } })).status, 400, path);
  }
  for (const authorization of [null, fixture.authorization]) {
    const response = await sendRaw(fixture.port, [
      "GET /api/data HTTP/1.1", `Host: ${publicHost}`, "Connection: Upgrade", "Upgrade: websocket",
      ...(authorization ? [`Authorization: ${authorization}`] : []),
    ]);
    assert.ok(response.startsWith(authorization ? "HTTP/1.1 405 " : "HTTP/1.1 401 "));
  }
  assert.equal(fixture.requests.length, 0);
});

test("redirects stay in the authenticated tunnel and are never followed upstream", async (t) => {
  let location = "/next?test=1";
  const fixture = await setup(t, (_incoming, outgoing) => { outgoing.writeHead(302, { location }); outgoing.end(); });
  let response = await fixture.send({ headers: { authorization: fixture.authorization } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${publicOrigin}/next?test=1`);
  assert.equal(fixture.requests.length, 1);
  location = `http://127.0.0.1:${fixture.upstreamPort}/next`;
  response = await fixture.send({ headers: { authorization: fixture.authorization } });
  assert.equal(response.headers.location, `${publicOrigin}/next`);
  location = "next?test=1";
  response = await fixture.send({ path: "/directory/item", headers: { authorization: fixture.authorization } });
  assert.equal(response.headers.location, `${publicOrigin}/directory/next?test=1`);
  for (const target of ["https://attacker.example/private", "//attacker.example/private",
    `http://user:password@127.0.0.1:${fixture.upstreamPort}/next`]) {
    location = target;
    response = await fixture.send({ headers: { authorization: fixture.authorization } });
    assert.equal(response.status, 502);
    assert.equal(response.headers.location, undefined);
  }
  assert.equal(fixture.requests.length, 6);
});

test("upstream disconnects return bounded failures without exposing error details", async (t) => {
  const fixture = await setup(t, (_incoming, outgoing) => outgoing.destroy(new Error("synthetic private upstream error")));
  const response = await fixture.send({ headers: { authorization: fixture.authorization } });
  assert.equal(response.status, 502);
  assert.equal(response.body.toString(), "Upstream unavailable.\n");
  assert.equal(response.body.includes("synthetic private"), false);
});

test("a truncated upstream response closes the stream and leaves the gateway usable", async (t) => {
  const fixture = await setup(t, (incoming, outgoing) => {
    if (incoming.path === "/healthy") { outgoing.end("ok"); return; }
    outgoing.writeHead(200, { "content-length": 1000 });
    outgoing.write("partial");
    setTimeout(() => outgoing.destroy(), 15);
  });
  await assert.rejects(fixture.send({ headers: { authorization: fixture.authorization } }), /aborted|reset|hang up/i);
  assert.equal((await fixture.send({ path: "/healthy", headers: { authorization: fixture.authorization } })).body.toString(), "ok");
});

test("gateway configuration rejects non-loopback and credential-bearing upstreams", () => {
  const options = { username: "test", password: randomBytes(24).toString("hex"), getPublicOrigin: () => publicOrigin };
  for (const upstreamUrl of ["https://127.0.0.1:4317", "http://192.168.1.1:4317", "http://example.com",
    "http://user:pass@127.0.0.1:4317", "http://127.0.0.1:4317/path"])
    assert.throws(() => createTunnelProxy({ ...options, upstreamUrl }), /HTTP loopback origin/);
  assert.throws(() => createTunnelProxy({ ...options, upstreamUrl: "http://127.0.0.1:4317", password: "" }), /credentials/);
});

test("gateway configuration rejects unknown authentication modes", () => {
  const options = {
    upstreamUrl: "http://127.0.0.1:4317", username: "test",
    password: randomBytes(24).toString("hex"), getPublicOrigin: () => publicOrigin,
  };
  for (const authentication of ["anonymous", "", null, false])
    assert.throws(() => createTunnelProxy({ ...options, authentication }), /authentication/i);
});
