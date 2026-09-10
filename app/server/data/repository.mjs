// Stable data port used by domain services. Concrete SQL belongs in adapters.
export const COLLECTIONS = Object.freeze([
  "feedback", "dishes", "plans", "transactions", "meta", "actions",
  "settings", "menuRuns", "imports", "aiUsage", "audit", "catalogEnglish",
]);
export function collectionName(value) {
  if (!COLLECTIONS.includes(value)) throw new Error("Unknown collection");
  return value;
}
export function createRepository(adapter, seed) {
  for (const method of ["all", "get", "put", "atomic", "close"])
    if (typeof adapter?.[method] !== "function") throw new TypeError(`Data adapter is missing ${method}`);
  const repository = Object.freeze({
    all: (collection) => adapter.all(collectionName(collection)),
    get: (collection, id) => adapter.get(collectionName(collection), id),
    put: (collection, id, record) => {
      collectionName(collection);
      if (typeof id !== "string" || !id) throw new TypeError("Record ID must be a nonempty string");
      if (record === undefined) throw new TypeError("Cannot store undefined");
      return adapter.put(collection, id, record);
    },
    atomic: (action) => {
      if (action?.constructor?.name === "AsyncFunction") throw new TypeError("Repository transactions must be synchronous");
      return adapter.atomic(() => {
        const result = action();
        if (result && typeof result.then === "function") throw new TypeError("Repository transactions must be synchronous");
        return result;
      });
    },
    close: () => adapter.close(),
  });
  try {
    if (!repository.get("meta", "initialized")) {
      if (typeof seed !== "function") throw new Error("An uninitialized repository requires a data seed");
      const data = seed();
      repository.atomic(() => {
        for (const collection of ["feedback", "dishes"])
          for (const record of data[collection] || []) repository.put(collection, record.id, record);
        for (const field of ["recipes", "rules", "inventory", "report"])
          repository.put("meta", field, data[field] ?? (field === "report" ? {} : []));
        repository.put("meta", "initialized", { at: new Date().toISOString(), version: 1 });
      });
    }
    return repository;
  } catch (error) { adapter.close(); throw error; }
}
