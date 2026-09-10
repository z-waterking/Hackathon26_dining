import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve(import.meta.dirname, "../app/data/cloudflare");
const state = JSON.parse(readFileSync(resolve(directory, "state.json"), "utf8"));
const anonymous = state.authentication === "none";
const origin = new URL(state.url);
if (state.status !== "ready" || origin.protocol !== "https:"
  || !origin.hostname.endsWith(".trycloudflare.com") || origin.origin !== state.url)
  throw new Error("No ready Cloudflare Quick Tunnel found.");
const credentials = anonymous ? null : JSON.parse(readFileSync(resolve(directory, "credentials.json"), "utf8"));
const authorization = credentials ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}` : null;
async function check(label, path, status, { authenticated = false, ...options } = {}) {
  const response = await fetch(`${origin.origin}${path}`, { signal: AbortSignal.timeout(20000), ...options,
    redirect: "manual", headers: { ...(authenticated && authorization ? { authorization } : {}), ...options.headers } });
  assert.equal(response.status, status, `${label}: HTTP ${response.status}, expected ${status}`);
  if (status === 401) assert.match(response.headers.get("www-authenticate"), /^Basic realm="Dining"/);
  if (anonymous) assert.equal(response.headers.get("www-authenticate"), null, "Anonymous mode must never request login");
  console.log(`${label}: HTTP ${status}`);
  return response;
}
if (!anonymous) {
  await check("Anonymous page denied", "/", 401);
  await check("Anonymous API denied", "/api/health", 401);
  await check("Wrong password denied", "/api/health", 401, { headers: { authorization: "Basic ZGluaW5nOm5vdC10aGUtcGFzc3dvcmQ=" } });
}
const mode = anonymous ? "No-login" : "Authenticated";
assert.deepEqual(await (await check(`${mode} health`, "/api/health", 200, { authenticated: !anonymous })).json(), { ok: true });
const html = await (await check(`${mode} page`, "/", 200, { authenticated: !anonymous })).text();
const asset = html.match(/src="([^"]+[.]js)"/);
assert.ok(asset && asset[1].startsWith("/assets/"), "Expected built frontend script");
if (!anonymous) await check("Anonymous frontend asset denied", asset[1], 401);
await check(`${mode} frontend asset`, asset[1], 200, { authenticated: !anonymous });
// An invalid payload exercises the real write-request guard without changing data.
await check("Same-origin empty payload validation (no write)", "/api/feedback", 400, { authenticated: true,
  method: "POST", headers: { "Content-Type": "application/json", origin: origin.origin }, body: "{}" });
await check("Foreign origin denied", "/api/feedback", 403, { authenticated: true,
  method: "POST", headers: { "Content-Type": "application/json", origin: "https://untrusted.example" }, body: "{}" });
const httpEntry = await fetch(`http://${origin.host}/`, { redirect: "manual", signal: AbortSignal.timeout(20000) });
assert.ok([301, 302, 307, 308].includes(httpEntry.status), "HTTP entry must redirect to HTTPS before authentication");
assert.equal(httpEntry.headers.get("location"), `${origin.origin}/`);
assert.equal(httpEntry.headers.get("www-authenticate"), null);
console.log(`HTTP entry redirects to HTTPS: ${httpEntry.status}`);
console.log("Tunnel verification passed; no business data or AI calls were submitted.");
