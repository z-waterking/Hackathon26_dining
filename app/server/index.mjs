import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { initializeLocalStore } from "./bootstrap.mjs";
import { createApp } from "./app.mjs";

const root = resolve(import.meta.dirname, "..");
if (existsSync(resolve(root, ".env"))) loadEnvFile(resolve(root, ".env"));
const store = await initializeLocalStore();
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
