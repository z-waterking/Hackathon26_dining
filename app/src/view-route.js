export const viewIds = Object.freeze(["feedback", "actions", "menus", "catalog", "analytics", "prompts"]);

export function viewFromHash(hash) {
  const id = typeof hash === "string" && hash.startsWith("#") ? hash.slice(1) : "";
  return viewIds.includes(id) ? id : "feedback";
}

// The current page is stored in this browser tab's URL, not shared storage.
// Preserve the deployment path and query parameters; never store drafts here.
export function writeViewRoute(browser, id, { replace = false } = {}) {
  if (!viewIds.includes(id)) return false;
  const url = new URL(browser.location.href);
  if (url.hash === "#" + id) return false;
  url.hash = id;
  browser.history[replace ? "replaceState" : "pushState"](browser.history.state, "", url.href);
  return true;
}
