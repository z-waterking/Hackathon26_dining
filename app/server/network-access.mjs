import { networkInterfaces } from "node:os";
import { isIPv4 } from "node:net";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const normalizeHost = (host) => typeof host === "string"
  ? host.toLowerCase().replace(/^\[(.*)\]$/, "$1") : "";

function isPrivateIPv4(address) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function createNetworkAccess({ mode = "local", interfaces = networkInterfaces() } = {}) {
  if (!["local", "lan"].includes(mode))
    throw new Error("DINING_NETWORK must be local or lan.");
  const hostnames = new Set(loopbackHosts);
  if (mode === "lan") {
    for (const entries of Object.values(interfaces))
      for (const entry of entries || [])
        if (!entry.internal && entry.family === "IPv4" && isPrivateIPv4(entry.address))
          hostnames.add(entry.address);
  }
  return Object.freeze({
    listenHost: mode === "lan" ? "0.0.0.0" : "127.0.0.1",
    hostnames,
    allowsHost: (hostname) => hostnames.has(normalizeHost(hostname)),
    allowsOrigin(origin, hostHeader) {
      if (origin === undefined) return true;
      if (typeof origin !== "string") return false;
      try {
        const source = new URL(origin);
        // Origin contains only scheme and authority, never a path or credentials.
        if (source.protocol !== "http:" || source.origin !== origin) return false;
        const hostname = normalizeHost(source.hostname);
        if (!hostnames.has(hostname)) return false;
        // Vite on a loopback port proxies development API calls to this service.
        if (loopbackHosts.has(hostname)) return true;
        const target = new URL(`http://${hostHeader}`);
        return target.host === hostHeader && source.origin === target.origin;
      } catch { return false; }
    },
  });
}
