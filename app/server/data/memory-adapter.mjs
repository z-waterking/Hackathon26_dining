import { COLLECTIONS, collectionName } from "./repository.mjs";

// Independent contract-test adapter, never an implicit production fallback.
export function createMemoryAdapter() {
  let collections = new Map(COLLECTIONS.map((name) => [name, new Map()]));
  let transaction = false;
  let closed = false;
  const table = (name) => {
    if (closed) throw new Error("Repository is closed");
    return collections.get(collectionName(name));
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  return {
    all: (name) => [...table(name).values()].map(copy),
    get: (name, id) => table(name).has(id) ? copy(table(name).get(id)) : null,
    put: (name, id, record) => { table(name).set(id, copy(record)); },
    atomic: (action) => {
      if (closed || transaction) throw new Error("Repository transaction is unavailable");
      const before = structuredClone(collections);
      transaction = true;
      try { return action(); }
      catch (error) { collections = before; throw error; }
      finally { transaction = false; }
    },
    close: () => { closed = true; },
  };
}
