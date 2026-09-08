import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createStore } from "../server/store.mjs";
import { readMaterials } from "../server/importer.mjs";
import { createApp } from "../server/app.mjs";

const temporary = mkdtempSync(resolve(tmpdir(), "dining-browser-"));
const store = createStore(resolve(temporary, "test.sqlite"), () =>
  readMaterials(resolve(import.meta.dirname, "../../materials/inspection")),
);
const app = createApp(store);
await app.listen({ port: 4499, host: "127.0.0.1" });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  });
