const GEMINI_API_KEY = "AIzaSyAWVVdHb7T2YRzYCTqibndBcLSf2-9GkKU";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MIN_EXPLANATION_LENGTH = 60;
const geminiExplanationCache = new Map();
const pendingExplanationRequests = new Map();
const BAD_RESPONSE_PHRASES = [
  "not in the common list",
  "common list",
  "not enough information",
  "insufficient information",
  "i cannot determine",
  "i can't determine",
  "unknown error without more context"
];

function normalizeErrorInput(errorInput) {
  return typeof errorInput === "string"
    ? { message: errorInput }
    : errorInput && typeof errorInput === "object"
    ? errorInput
    : {};
}

function getErrorSignature(error) {
  const stack = String(error?.stack || "").trim();
  const message = String(error?.message || "").trim();
  const type = String(error?.type || "").trim();

  if (stack) {
    return `stack:${stack}`;
  }

  return `message:${type}:${message}`;
}

function detectErrorKind(error) {
  const message = String(error?.message || "").toLowerCase();
  const type = String(error?.type || "").toLowerCase();

  if (type.includes("resource") || message.includes("failed to load") || message.includes("network")) {
    return "network/resource";
  }

  if (message.includes("referenceerror") || message.includes("is not defined")) {
    return "reference";
  }

  if (
    message.includes("typeerror") ||
    message.includes("cannot read properties of undefined") ||
    message.includes("cannot read properties of null") ||
    message.includes("is not a function")
  ) {
    return "type";
  }

  return "runtime";
}

function getDynamicHints(error) {
  const message = String(error?.message || "").toLowerCase();
  const type = String(error?.type || "").toLowerCase();
  const hints = [];

  if (message.includes("cannot read properties of null") || (message.includes("cannot read property") && message.includes("null"))) {
    hints.push("The code probably expected an object, but the value was null.");
  }

  if (
    message.includes("cannot read properties of undefined") ||
    (message.includes("cannot read property") && !message.includes("null"))
  ) {
    hints.push("The code probably tried to read a property from a value that is undefined.");
  }

  if (message.includes("is not defined")) {
    hints.push("A variable or function name was used before it was declared, imported, or loaded.");
  }

  if (message.includes("is not a function")) {
    hints.push("The code used () on a value that is not actually a function.");
  }

  if (message.includes("unexpected token")) {
    hints.push("There is probably a syntax mistake, such as a missing bracket, comma, quote, or wrong file format.");
  }

  if (type.includes("unhandledrejection")) {
    hints.push("A Promise failed without a catch handler or try/catch.");
  }

  if (type.includes("resource") || message.includes("failed to load")) {
    hints.push("A file or network resource probably failed to load.");
  }

  return hints.length ? hints.join("\n") : "Infer the most likely cause from the error message and stack trace.";
}

function getFallbackExplanation(errorInput) {
  const error = normalizeErrorInput(errorInput);
  const message = String(error.message || "Unknown JavaScript error");
  const normalized = message.toLowerCase();
  const type = String(error.type || "").toLowerCase();

  if (normalized.includes("cannot read properties of null")) {
    return `Cause:\nYour code expected an object, but the value was null.\n\nFix:\nCheck for null before reading properties or attaching events.\n\nExample:\nconst button = document.querySelector("#save");\nif (button) {\n  button.addEventListener("click", saveData);\n}`;
  }

  if (normalized.includes("cannot read properties of undefined") || normalized.includes("cannot read property")) {
    return `Cause:\nYour code is trying to read a property from a value that is undefined.\n\nFix:\nCheck that the object exists before using its property, or use optional chaining/default values.\n\nExample:\nconst user = data?.user;\nconsole.log(user?.name || "No name");`;
  }

  if (normalized.includes("is not defined")) {
    return `Cause:\nJavaScript cannot find the variable or function name you used.\n\nFix:\nDeclare it, import it, or make sure the script that creates it loads first.\n\nExample:\nconst total = 10;\nconsole.log(total);`;
  }

  if (normalized.includes("is not a function")) {
    return `Cause:\nYour code is calling something with (), but that value is not a function.\n\nFix:\nCheck the value before calling it and make sure you are using the correct method name.\n\nExample:\nif (typeof saveData === "function") {\n  saveData();\n}`;
  }

  if (normalized.includes("unexpected token")) {
    return `Cause:\nJavaScript found text or a symbol where it did not expect one.\n\nFix:\nCheck the line in the stack trace for a missing bracket, comma, quote, or extra character.\n\nExample:\nconst user = { name: "Alex" };\nconsole.log(user.name);`;
  }

  if (type.includes("unhandledrejection")) {
    return `Cause:\nA Promise failed, but the error was not handled.\n\nFix:\nUse try/catch with await, or add .catch() to the Promise.\n\nExample:\ntry {\n  await loadData();\n} catch (error) {\n  console.error(error);\n}`;
  }

  if (type.includes("resource") || normalized.includes("failed to load")) {
    return `Cause:\nA file or network resource failed to load.\n\nFix:\nCheck the file path, URL, server response, and whether the file exists.\n\nExample:\n<script src="app.js"></script>`;
  }

  return `Cause:\nThis error happened while JavaScript was running. The message points to the failing code: ${message}\n\nFix:\nCheck the line in the stack trace and verify the values used there before using them.\n\nExample:\nif (value !== undefined && value !== null) {\n  console.log(value);\n}`;
}

function buildPrompt(error) {
  const message = String(error.message || "Unknown JavaScript error").trim();
  const type = String(error.type || "runtime").trim();
  const stack = String(error.stack || "No stack trace available").trim();
  const hints = getDynamicHints(error);
  const errorKind = detectErrorKind(error);

  return `
You are an expert JavaScript tutor helping a beginner fix a real browser error.

Your task:
- Explain the specific error using the error message, error type, stack trace, and hints.
- NEVER give a generic answer.
- NEVER say "not in the common list".
- NEVER say there is not enough information.
- ALWAYS explain the most likely real cause.
- ALWAYS provide a practical fix.
- ALWAYS include a small code example directly related to the error kind, or write exactly "No code example needed."

Format your answer exactly like this:

Cause:
1-3 short beginner-friendly sentences explaining what caused this exact error.

Fix:
1-3 short beginner-friendly sentences explaining how to solve it.

Example:
A tiny JavaScript example that matches the error kind, or "No code example needed."

Quality rules:
- Use very simple English.
- Be specific to this error.
- Keep it short, but useful.
- Do not use markdown tables.
- Do not use bullet lists.
- Do not repeat the full stack trace.
- Do not leave any section empty.
- If the error kind is network/resource, use a network, URL, script, image, or fetch example.
- If the error kind is reference, use a missing variable, missing import, or load-order example.
- If the error kind is type, use a null, undefined, object property, or function-call example.

Error message:
${message}

Error type:
${type}

Detected error kind:
${errorKind}

Helpful hints:
${hints}

Stack trace:
${stack}
  `.trim();
}

function cleanExplanation(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasBadPhrase(text) {
  const normalized = String(text || "").toLowerCase();
  return BAD_RESPONSE_PHRASES.some((phrase) => normalized.includes(phrase));
}

function hasRequiredSections(text) {
  return text.includes("Cause:") && text.includes("Fix:") && text.includes("Example:");
}

function isUsableExplanation(text) {
  return text.length >= MIN_EXPLANATION_LENGTH && hasRequiredSections(text) && !hasBadPhrase(text);
}

async function explainJavaScriptError(errorInput) {
  const error = normalizeErrorInput(errorInput);
  const message = String(error.message || "").trim();

  if (!message) {
    return getFallbackExplanation({ message: "Unknown JavaScript error" });
  }

  const cacheKey = getErrorSignature(error);
  if (geminiExplanationCache.has(cacheKey)) {
    return geminiExplanationCache.get(cacheKey);
  }

  if (pendingExplanationRequests.has(cacheKey)) {
    return pendingExplanationRequests.get(cacheKey);
  }

  if (!GEMINI_API_KEY || GEMINI_API_KEY === "PASTE_YOUR_GEMINI_API_KEY_HERE") {
    const fallback = getFallbackExplanation(error);
    geminiExplanationCache.set(cacheKey, fallback);
    return fallback;
  }

  const request = fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: buildPrompt(error) }]
          }
        ],
        generationConfig: {
          temperature: 0.15,
          topP: 0.9,
          topK: 40,
          maxOutputTokens: 700
        }
      })
    })
    .then(async (response) => {
      if (!response.ok) {
        return getFallbackExplanation(error);
      }

      let data;
      try {
        data = await response.json();
      } catch (_) {
        return getFallbackExplanation(error);
      }

      const explanation = cleanExplanation(data?.candidates?.[0]?.content?.parts?.[0]?.text);
      return isUsableExplanation(explanation) ? explanation : getFallbackExplanation(error);
    })
    .catch(() => getFallbackExplanation(error))
    .then((finalExplanation) => {
      geminiExplanationCache.set(cacheKey, finalExplanation);
      return finalExplanation;
    })
    .finally(() => {
      pendingExplanationRequests.delete(cacheKey);
    });

  pendingExplanationRequests.set(cacheKey, request);
  return request;
}

globalThis.ExplainErrorAI = {
  explainJavaScriptError
};
globalThis.explainJavaScriptError = explainJavaScriptError;
