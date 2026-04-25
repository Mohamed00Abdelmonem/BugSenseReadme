const MAX_ERRORS = 20;
const DEDUPE_TTL_MS = 1500;
const capturedErrors = [];
const signatureTimes = new Map();
const CAPTURE_EVENT = "EXPLAIN_ERROR_CAPTURE_EVENT";

console.log("[Explain Error] content script loaded", window.location.href);

/**
 * @param {string} message
 * @returns {string}
 */
function explainError(message) {
  if (!message || typeof message !== "string") {
    return "An unknown error occurred. Check the stack trace and recent code changes.";
  }

  const normalized = message.toLowerCase();

  if (normalized.includes("is not defined")) {
    return "You are using a variable or function name that has not been declared or is out of scope.";
  }

  if (normalized.includes("is not a function")) {
    return "You are trying to call something with () that is not actually a function. Check the variable's value and type.";
  }

  if (
    normalized.includes("cannot read properties of undefined") ||
    normalized.includes("cannot read property")
  ) {
    return "Code tried to access a property on undefined. Verify the object exists before reading its fields.";
  }

  return "This error is not in the common list yet. Read the message and stack trace to locate the failing code path.";
}

/**
 * @param {any} line
 * @returns {number|null}
 */
function normalizeLineValue(line) {
  return Number.isFinite(line) ? Number(line) : null;
}

/**
 * @param {any} raw
 * @returns {object}
 */
function normalizeError(raw) {
  const message = String(raw?.message || "Unknown runtime error");
  return {
    type: String(raw?.type || "runtime"),
    message,
    explanation: explainError(message),
    source: String(raw?.source || ""),
    line: normalizeLineValue(raw?.line),
    column: normalizeLineValue(raw?.column),
    stack: String(raw?.stack || ""),
    timestamp: String(raw?.timestamp || new Date().toISOString())
  };
}

/**
 * @param {object} error
 * @returns {string}
 */
function buildSignature(error) {
  return [error.type, error.message, error.source, error.line, error.column].join("|");
}

function sendRuntimeMessage(message, callback) {
  if (!chrome?.runtime?.id) {
    return;
  }

  try {
    chrome.runtime.sendMessage(message, (...args) => {
      try {
        callback?.(...args);
      } catch (error) {
        console.log("[Explain Error] runtime callback failed", error?.message || error);
      }
    });
  } catch (error) {
    console.log("[Explain Error] extension context is not available", error?.message || error);
  }
}

/**
 * @param {object} error
 */
function storeError(error) {
  const signature = buildSignature(error);
  const now = Date.now();
  const previous = signatureTimes.get(signature);

  if (previous && now - previous < DEDUPE_TTL_MS) {
    return;
  }

  signatureTimes.set(signature, now);

  capturedErrors.unshift(error);
  if (capturedErrors.length > MAX_ERRORS) {
    capturedErrors.length = MAX_ERRORS;
  }

  console.log("[Explain Error] captured", error);
  sendRuntimeMessage({ type: "CAPTURE_ERROR", error }, () => {
    if (chrome.runtime.lastError) {
      console.log("[Explain Error] sendMessage failed", chrome.runtime.lastError.message);
    }
  });
}

function capture(rawError) {
  storeError(normalizeError(rawError));
}

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (!data || data.source !== "EXPLAIN_ERROR_PAGE" || data.channel !== "EXPLAIN_ERROR_CAPTURED") {
    return;
  }

  capture(data.payload || {});
});

document.addEventListener(CAPTURE_EVENT, (event) => {
  try {
    capture(JSON.parse(event.detail || "{}"));
  } catch (_) {
    capture({
      type: "event.parse",
      message: "Explain Error received an unreadable captured error payload."
    });
  }
});

window.postMessage({ source: "EXPLAIN_ERROR_CONTENT_READY" }, "*");

window.onerror = function (message, source, lineno, colno, error) {
  capture({
    type: "window.onerror",
    message: String(message || "Unknown runtime error"),
    source: source || "",
    line: lineno,
    column: colno,
    stack: error && error.stack ? String(error.stack) : ""
  });
  return false;
};

window.addEventListener(
  "error",
  (event) => {
    const target = event && event.target;
    if (target && target !== window) {
      const source = target.src || target.href || "";
      capture({
        type: "event.error.resource",
        message: `Resource failed to load: ${target.tagName || "UNKNOWN"}`,
        source
      });
      return;
    }

    capture({
      type: "event.error",
      message: String(event?.message || "Script error"),
      source: event?.filename || "",
      line: event?.lineno,
      column: event?.colno,
      stack: event?.error?.stack ? String(event.error.stack) : ""
    });
  },
  true
);

window.addEventListener("unhandledrejection", (event) => {
  const reason = event?.reason;
  capture({
    type: "unhandledrejection",
    message:
      typeof reason === "string"
        ? reason
        : reason?.message
        ? String(reason.message)
        : "Unhandled promise rejection",
    stack: reason?.stack ? String(reason.stack) : ""
  });
});

try {
  if (chrome?.runtime?.id) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (!request || !request.type) {
        return;
      }

      if (request.type === "GET_LOCAL_ERRORS") {
        sendResponse({ errors: capturedErrors });
        return;
      }

      if (request.type === "CLEAR_LOCAL_ERRORS") {
        capturedErrors.length = 0;
        signatureTimes.clear();
        sendResponse({ ok: true });
      }
    });
  }
} catch (error) {
  console.log("[Explain Error] could not attach runtime listener", error?.message || error);
}
