import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTunnelProxy } from "../app/server/tunnel-proxy.mjs";

const directory = resolve(import.meta.dirname, "../app/data/cloudflare");
const port = Number(process.argv[2] || 4317);
const gatewayPort = Number(process.argv[3] || 4319);
const authentication = process.argv[4] || "basic";
if (!["basic", "none"].includes(authentication)) throw new Error("Authentication must be basic or none.");
if (![port, gatewayPort].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535) || port === gatewayPort)
  throw new Error("Use distinct application and gateway ports between 1024 and 65535.");
mkdirSync(directory, { recursive: true });
const credentialPath = resolve(directory, "credentials.json");
const accessPath = resolve(directory, "access.txt");
const statePath = resolve(directory, "state.json");
const logPath = resolve(directory, "cloudflared.log");
const executable = resolve(directory, "cloudflared.exe");
const upstreamUrl = `http://127.0.0.1:${port}`;
const health = await fetch(`${upstreamUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
if (!health.ok || (await health.json()).ok !== true) throw new Error("Start the Dining application before its tunnel.");
const credentials = authentication === "none" ? null
  : existsSync(credentialPath) ? JSON.parse(readFileSync(credentialPath, "utf8"))
    : { username: "dining", password: randomBytes(24).toString("base64url") };
if (credentials && (credentials.username !== "dining" || !/^[A-Za-z0-9_-]{32,}$/.test(credentials.password)))
  throw new Error("Invalid tunnel credentials file; expected the generated Dining credentials.");
if (credentials && !existsSync(credentialPath)) writeFileSync(credentialPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: "wx" });
let publicOrigin = null;
let tunnel;
let stopping = false;
let ready = false;
let startupTimer;
const startedAt = new Date().toISOString();
const proxy = createTunnelProxy({ upstreamUrl, ...credentials, authentication, getPublicOrigin: () => publicOrigin });
function saveState(status, error) {
  writeFileSync(statePath, `${JSON.stringify({ status, pid: process.pid, tunnelPid: tunnel?.pid,
    port, gatewayPort, authentication, url: publicOrigin, accessFile: accessPath, startedAt, ...(error ? { error } : {}) }, null, 2)}\n`);
}
function saveAccess() {
  if (authentication === "none") {
    writeFileSync(accessPath, `Dining workbench — temporary Cloudflare access\n\nURL: ${publicOrigin || "Not running"}\nAuthentication: none — open the URL directly.\n\nKeep this computer and the Dining application running.\nThe URL changes when the tunnel is restarted.\n`, { mode: 0o600 });
    return;
  }
  writeFileSync(accessPath, `Dining workbench — temporary Cloudflare access\n\nURL: ${publicOrigin || "Starting; not ready"}\nUsername: ${credentials.username}\nPassword: ${credentials.password}\n\nShare these credentials only with intended colleagues.\nKeep this computer and the Dining application running.\nThe URL changes when the tunnel is restarted.\n`, { mode: 0o600 });
}
async function stop(code = 0, message) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimer);
  publicOrigin = null;
  saveState(code ? "failed" : "stopped", message);
  saveAccess();
  if (tunnel && tunnel.exitCode === null) tunnel.kill();
  proxy.closeAllConnections();
  await new Promise(resolveClose => proxy.close(resolveClose));
  process.exitCode = code;
}
await new Promise((resolveListen, reject) => {
  proxy.once("error", reject);
  proxy.listen(gatewayPort, "127.0.0.1", resolveListen);
});
proxy.on("error", error => { void stop(1, error.code || "Gateway error"); });
writeFileSync(logPath, "");
saveState("starting");
saveAccess();
tunnel = spawn(executable, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${gatewayPort}`,
  "--protocol", "http2", "--edge-ip-version", "4", "--metrics", "127.0.0.1:0", "--loglevel", "info"],
{ cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
saveState("starting");
let logTail = "";
function onLog(chunk) {
  const text = chunk.toString("utf8");
  appendFileSync(logPath, text);
  logTail = (logTail + text).slice(-16000);
  if (!publicOrigin) {
    const match = logTail.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/);
    if (match) {
      publicOrigin = match[0];
      saveState("connecting");
      saveAccess();
    }
  }
  if (!ready && publicOrigin && /Registered tunnel connection/.test(logTail)) {
    ready = true;
    clearTimeout(startupTimer);
    saveState("ready");
    console.log(`Cloudflare URL: ${publicOrigin}`);
    console.log(authentication === "none" ? "No login required." : `Login details: ${accessPath}`);
  }
}
tunnel.stdout.on("data", onLog);
tunnel.stderr.on("data", onLog);
tunnel.on("error", error => { void stop(1, error.code || "cloudflared could not start"); });
tunnel.on("exit", code => { if (!stopping) void stop(1, `cloudflared exited (${code})`); });
startupTimer = setTimeout(() => { void stop(1, "Cloudflare connection timed out; check cloudflared.log"); }, 90000);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void stop(); });
