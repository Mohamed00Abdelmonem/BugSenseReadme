importScripts("config.js", "ai.js");

const MAX_ERRORS = 20;
const DEDUPE_TTL_MS = 1500;

/** @type {Map<number, Array<object>>} */
const tabErrors = new Map();
/** @type {Map<number, Map<string, number>>} */
const tabSignatures = new Map();

/**
 * @param {Array<object>} first
 * @param {Array<object>} second
 * @returns {Array<object>}
 */
function mergeErrors(first, second) {
  const seen = new Set();
  const merged = [];

  [...first, ...second].forEach((error) => {
    const signature = [
      error?.type,
      error?.message,
      error?.source,
      error?.line,
      error?.column,
      error?.timestamp
    ].join("|");

    if (seen.has(signature)) {
      return;
    }

    seen.add(signature);
    merged.push(error);
  });

  return merged.slice(0, MAX_ERRORS);
}

/**
 * @param {number} tabId
 * @returns {Array<object>}
 */
function getTabErrors(tabId) {
  if (!tabErrors.has(tabId)) {
    tabErrors.set(tabId, []);
  }
  return tabErrors.get(tabId);
}

/**
 * @param {number} tabId
 * @returns {Map<string, number>}
 */
function getTabDeduper(tabId) {
  if (!tabSignatures.has(tabId)) {
    tabSignatures.set(tabId, new Map());
  }
  return tabSignatures.get(tabId);
}

/**
 * @param {number} tabId
 * @param {any} error
 */
function storeError(tabId, error) {
  const safeError = {
    type: error?.type || "runtime",
    message: String(error?.message || "Unknown error"),
    explanation: String(error?.explanation || "No explanation available."),
    source: String(error?.source || ""),
    line: Number.isFinite(error?.line) ? Number(error.line) : null,
    column: Number.isFinite(error?.column) ? Number(error.column) : null,
    stack: String(error?.stack || ""),
    timestamp: String(error?.timestamp || new Date().toISOString())
  };

  const signature = [
    safeError.type,
    safeError.message,
    safeError.source,
    safeError.line,
    safeError.column
  ].join("|");

  const now = Date.now();
  const deduper = getTabDeduper(tabId);
  const previous = deduper.get(signature);

  if (previous && now - previous < DEDUPE_TTL_MS) {
    return;
  }

  deduper.set(signature, now);

  const list = getTabErrors(tabId);
  list.unshift(safeError);
  if (list.length > MAX_ERRORS) {
    list.length = MAX_ERRORS;
  }
}

function getActiveTabId(sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }

    const activeTab = tabs && tabs[0];
    if (!activeTab || activeTab.id == null) {
      sendResponse({ ok: false, error: "No active tab found." });
      return;
    }

    sendResponse({ ok: true, tabId: activeTab.id });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabErrors.delete(tabId);
  tabSignatures.delete(tabId);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request.type !== "string") {
    return;
  }

  if (request.type === "CAPTURE_ERROR") {
    const tabId = sender?.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: "No sender tab ID available." });
      return;
    }

    storeError(tabId, request.error);
    sendResponse({ ok: true });
    return;
  }

  if (request.type === "GET_ERRORS_ACTIVE_TAB") {
    getActiveTabId((tabResponse) => {
      if (!tabResponse.ok) {
        sendResponse({ ok: false, error: tabResponse.error, errors: [] });
        return;
      }

      const tabId = tabResponse.tabId;
      const storedErrors = getTabErrors(tabId);

      chrome.tabs.sendMessage(tabId, { type: "GET_LOCAL_ERRORS" }, (localResponse) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: true, errors: storedErrors });
          return;
        }

        const localErrors = Array.isArray(localResponse?.errors) ? localResponse.errors : [];
        sendResponse({ ok: true, errors: mergeErrors(storedErrors, localErrors) });
      });
    });
    return true;
  }

  if (request.type === "CLEAR_ERRORS_ACTIVE_TAB") {
    getActiveTabId((tabResponse) => {
      if (!tabResponse.ok) {
        sendResponse({ ok: false, error: tabResponse.error });
        return;
      }

      const tabId = tabResponse.tabId;
      tabErrors.set(tabId, []);
      tabSignatures.set(tabId, new Map());

      chrome.tabs.sendMessage(tabId, { type: "CLEAR_LOCAL_ERRORS" }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (request.type === "EXPLAIN_ERROR_WITH_GEMINI") {
    const explainWithGemini = globalThis.ExplainErrorAI?.explainJavaScriptError;
    if (typeof explainWithGemini !== "function") {
      sendResponse({ ok: false, error: "Gemini helper was not loaded. Check ai.js and reload the extension." });
      return;
    }

    explainWithGemini(request.error)
      .then((explanation) => {
        sendResponse({ ok: true, explanation });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "Could not explain this error with Gemini."
        });
      });
    return true;
  }
});
