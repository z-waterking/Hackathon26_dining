import { resolve } from "node:path";
import { createStore } from "./store.mjs";
import { readMaterials } from "./importer.mjs";
import { createApp } from "./app.mjs";

const root = resolve(import.meta.dirname, "..");
const store = createStore(
  process.env.DINING_DB || resolve(root, "data/dining.sqlite"),
  () => readMaterials(resolve(root, "../materials/inspection")),
);
const app = createApp(store);
const port = Number(process.env.PORT || 4317);
try {
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Dining workbench: http://127.0.0.1:${port}`);
} catch (error) {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${port} is in use. Set PORT to another free port.`
      : error.message,
  );
  store.close();
  process.exitCode = 1;
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    store.close();
    process.exitCode = 0;
  });
