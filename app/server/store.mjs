// Compatibility factory; business services receive a repository, never SQL.
import { createRepository } from "./data/repository.mjs";
import { createSqliteAdapter } from "./data/sqlite-adapter.mjs";

export function createStore(filename, seed) {
  return createRepository(createSqliteAdapter(filename), seed);
}
