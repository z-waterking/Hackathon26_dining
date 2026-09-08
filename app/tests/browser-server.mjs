import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createStore } from "../server/store.mjs";
import { readMaterials } from "../server/importer.mjs";
import { createApp } from "../server/app.mjs";

export default async function setupBrowserServer() {
  const temporaryRoot = resolve(tmpdir());
  const temporary = mkdtempSync(resolve(temporaryRoot, "dining-browser-"));
  let store;
  let app;
  let cleanupPromise;
  const removeTemporary = () => {
    const within = relative(temporaryRoot, resolve(temporary));
    if (isAbsolute(within) || within.startsWith("..") || within.includes(sep) || !within.startsWith("dining-browser-"))
      throw new Error("Refusing to remove a directory outside the isolated browser test workspace");
    rmSync(temporary, { recursive: true, force: true });
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        if (app) {
          // Only this test server is closed. Destroy any retained browser
          // keep-alive sockets so shutdown cannot wait indefinitely.
          const closing = app.close();
          app.server.closeAllConnections();
          await closing;
        }
      } finally {
        try { store?.close(); } finally { removeTemporary(); }
      }
    })();
    return cleanupPromise;
  };
  try {
    store = createStore(resolve(temporary, "test.sqlite"), () =>
      readMaterials(resolve(import.meta.dirname, "../../materials/inspection")),
    );
    app = createApp(store, resolve(import.meta.dirname, "../dist"), { root: temporary });
    await app.listen({ port: 4499, host: "127.0.0.1" });
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
