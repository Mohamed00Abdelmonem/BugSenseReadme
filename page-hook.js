(() => {
  if (window.__explainErrorHookInstalled) {
    return;
  }

  window.__explainErrorHookInstalled = true;

  const CHANNEL = "EXPLAIN_ERROR_CAPTURED";
  const CAPTURE_EVENT = "EXPLAIN_ERROR_CAPTURE_EVENT";
  const queue = [];
  const MAX_QUEUE = 20;

  console.log("[Explain Error] page hook loaded", window.location.href);

  function post(payload) {
    queue.push(payload);
    if (queue.length > MAX_QUEUE) {
      queue.shift();
    }

    send(payload);
  }

  function send(payload) {
    try {
      window.postMessage(
        {
          source: "EXPLAIN_ERROR_PAGE",
          channel: CHANNEL,
          payload
        },
        "*"
      );
    } catch (_) {
      // Nothing useful to do if the page blocks or breaks message posting.
    }

    try {
      document.dispatchEvent(
        new CustomEvent(CAPTURE_EVENT, {
          detail: JSON.stringify(payload)
        })
      );
    } catch (_) {
      // Keep the hook harmless if a page overrides DOM primitives oddly.
    }
  }

  function flush() {
    queue.forEach(send);
  }

  function asText(value) {
    if (typeof value === "string") {
      return value;
    }

    if (value instanceof Error) {
      return value.message || String(value);
    }

    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }

  window.addEventListener(
    "error",
    (event) => {
      const target = event && event.target;
      if (target && target !== window) {
        post({
          type: "event.error.resource",
          message: `Resource failed to load: ${target.tagName || "UNKNOWN"}`,
          source: target.src || target.href || ""
        });
        return;
      }

      post({
        type: "event.error",
        message: asText(event?.message || "Script error"),
        source: event?.filename || "",
        line: Number.isFinite(event?.lineno) ? event.lineno : null,
        column: Number.isFinite(event?.colno) ? event.colno : null,
        stack: event?.error?.stack ? String(event.error.stack) : ""
      });
    },
    true
  );

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    post({
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

  const originalConsoleError = console.error;
  console.error = function (...args) {
    post({
      type: "console.error",
      message: args.map(asText).join(" | "),
      source: window.location?.href || ""
    });

    return originalConsoleError.apply(this, args);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "EXPLAIN_ERROR_CONTENT_READY") {
      return;
    }

    flush();
  });

  setTimeout(flush, 0);
  setTimeout(flush, 250);
  setTimeout(flush, 1000);
})();
