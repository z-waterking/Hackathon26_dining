import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createNetworkAccess } from "../server/network-access.mjs";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

const lanAddress = "10.2.165.12";
const lanHost = `${lanAddress}:4317`;
const lanOrigin = `http://${lanHost}`;
const adapter = (address, family = "IPv4") => ({ address, family, internal: false });
const interfaces = {
  Ethernet: [adapter(lanAddress), adapter("203.0.113.8"), adapter("fe80::1234", "IPv6")],
  WiFi: [adapter("192.168.10.20")],
  VPN: [adapter("172.16.0.5"), adapter("172.31.255.254")],
  Other: [adapter("172.15.255.254"), adapter("172.32.0.1"), adapter("100.64.0.1"), adapter("169.254.1.2")],
  Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
};

test("network access defaults to loopback and rejects unknown modes", () => {
  const access = createNetworkAccess({ interfaces });
  assert.equal(access.listenHost, "127.0.0.1");
  assert.ok(access.hostnames instanceof Set);
  for (const hostname of ["localhost", "127.0.0.1"])
    assert.equal(access.allowsHost(hostname), true, hostname);
  for (const hostname of [lanAddress, "192.168.10.20", "external.example", "0.0.0.0"])
    assert.equal(access.allowsHost(hostname), false, hostname);
  assert.equal(access.allowsOrigin(lanOrigin, lanHost), false);
  assert.throws(() => createNetworkAccess({ mode: "public", interfaces }));
});

test("LAN access allows only loopback and RFC1918 addresses assigned to this machine", () => {
  const access = createNetworkAccess({ mode: "lan", interfaces });
  assert.equal(access.listenHost, "0.0.0.0");
  for (const hostname of ["localhost", "127.0.0.1", lanAddress, "192.168.10.20", "172.16.0.5", "172.31.255.254"]) {
    assert.equal(access.allowsHost(hostname), true, hostname);
    assert.ok(access.hostnames.has(hostname), hostname);
  }
  for (const hostname of [
    "10.2.165.13", "192.168.10.21", "172.20.0.1",
    "172.15.255.254", "172.32.0.1", "100.64.0.1", "169.254.1.2",
    "203.0.113.8", "fe80::1234", "external.example", "localhost.external.example", "0.0.0.0",
  ])
    assert.equal(access.allowsHost(hostname), false, hostname);
});

test("LAN origins must match the request host and port", () => {
  const access = createNetworkAccess({ mode: "lan", interfaces });
  assert.equal(access.allowsOrigin(undefined, lanHost), true);
  assert.equal(access.allowsOrigin(lanOrigin, lanHost), true);
  assert.equal(access.allowsOrigin("http://192.168.10.20:4318", "192.168.10.20:4318"), true);
  for (const origin of [
    `http://${lanAddress}:4318`, `http://${lanAddress}`,
    "http://192.168.10.20:4317", "http://10.2.165.13:4317",
    "http://external.example:4317", `https://${lanHost}`,
  ])
    assert.equal(access.allowsOrigin(origin, lanHost), false, origin);
  assert.equal(access.allowsOrigin(lanOrigin, "external.example:4317"), false);
});

test("local and LAN modes preserve localhost Vite proxy origins", () => {
  for (const mode of ["local", "lan"]) {
    const access = createNetworkAccess({ mode, interfaces });
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5174", "http://localhost:65535"])
      assert.equal(access.allowsOrigin(origin, "127.0.0.1:4317"), true, `${mode}: ${origin}`);
    for (const origin of ["https://localhost:5173", "http://localhost:65536", "http://127.0.0.1:-1"])
      assert.equal(access.allowsOrigin(origin, "127.0.0.1:4317"), false, `${mode}: ${origin}`);
  }
});

test("Origin parsing rejects malformed and non-origin URL values", () => {
  const access = createNetworkAccess({ mode: "lan", interfaces });
  for (const origin of [
    "null", "not a URL", `//${lanHost}`, `ftp://${lanHost}`,
    `http://user@${lanHost}`, `${lanOrigin}/feedback`, `${lanOrigin}?test=1`, `${lanOrigin}#fragment`,
    `http://${lanAddress}:65536`, `http://${lanAddress}:-1`, `${lanOrigin}, http://external.example`,
  ])
    assert.equal(access.allowsOrigin(origin, lanHost), false, origin);
});

function setup(t, networkAccess) {
  const store = createStore(":memory:", () => ({ feedback: [], dishes: [] }));
  const aiCalls = [];
  const ai = {
    status: () => ({ configured: false }),
    respond: async (request) => {
      aiCalls.push(request);
      throw new Error("Network access tests must not call AI");
    },
  };
  const app = createApp(store, resolve(import.meta.dirname, "__missing_network_access_dist__"), { ai, networkAccess });
  t.after(async () => {
    await app.close();
    store.close();
    assert.deepEqual(aiCalls, []);
  });
  return { app, store };
}

const feedback = {
  content: "网络访问测试的合成反馈", restaurant: "测试档口",
  date: "2026-09-09", channel: "手工", type: "建议",
};
const headers = (host = lanHost, origin = lanOrigin) => ({ host, origin, "content-type": "application/json" });

test("LAN API serves health and persists same-origin feedback creation and updates", async (t) => {
  const { app, store } = setup(t, createNetworkAccess({ mode: "lan", interfaces }));
  const health = await app.inject({ method: "GET", url: "/api/health", headers: { host: lanHost } });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { ok: true });

  const created = await app.inject({ method: "POST", url: "/api/feedback", headers: headers(), payload: feedback });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().item.id;
  assert.equal(store.get("feedback", id).content, feedback.content);

  const updated = await app.inject({
    method: "PATCH", url: `/api/feedback/${id}`, headers: headers(),
    payload: { status: "已完成", owner: "测试人员", note: "合成记录验证完成" },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(store.get("feedback", id).status, "已完成");
  assert.equal(store.all("feedback").length, 1);
});

test("LAN API rejects untrusted origins and hosts without changing stored data", async (t) => {
  const { app, store } = setup(t, createNetworkAccess({ mode: "lan", interfaces }));
  const created = await app.inject({ method: "POST", url: "/api/feedback", headers: headers(), payload: feedback });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().item.id;
  const before = { feedback: store.all("feedback"), audit: store.all("audit"), aiUsage: store.all("aiUsage") };
  const rejectedHeaders = [
    headers(lanHost, "http://external.example"),
    headers(lanHost, "http://10.2.165.13:4317"),
    headers(lanHost, `http://${lanAddress}:4318`),
    headers(lanHost, `https://${lanHost}`),
    headers(lanHost, "null"),
    headers("external.example:4317", "http://external.example:4317"),
    headers("10.2.165.13:4317", "http://10.2.165.13:4317"),
    { ...headers("external.example:4317"), "x-forwarded-host": lanHost },
  ];
  for (const requestHeaders of rejectedHeaders) {
    const blockedCreate = await app.inject({
      method: "POST", url: "/api/feedback", headers: requestHeaders, payload: feedback,
    });
    assert.equal(blockedCreate.statusCode, 403, JSON.stringify(requestHeaders));
    const blockedUpdate = await app.inject({
      method: "PATCH", url: `/api/feedback/${id}`, headers: requestHeaders,
      payload: { status: "已完成", owner: "意外修改", note: "不应写入的合成记录" },
    });
    assert.equal(blockedUpdate.statusCode, 403, JSON.stringify(requestHeaders));
  }
  assert.deepEqual({ feedback: store.all("feedback"), audit: store.all("audit"), aiUsage: store.all("aiUsage") }, before);
});

test("the default API still rejects non-loopback hosts", async (t) => {
  const { app, store } = setup(t);
  for (const host of [lanHost, "external.example:4317", "0.0.0.0:4317"]) {
    const response = await app.inject({ method: "GET", url: "/api/health", headers: { host } });
    assert.equal(response.statusCode, 403, host);
  }
  const local = await app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1:4317" } });
  assert.equal(local.statusCode, 200);
  assert.deepEqual(store.all("feedback"), []);
});
