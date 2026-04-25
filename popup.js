const statusEl = document.getElementById("status");
const errorsListEl = document.getElementById("errorsList");
const clearBtn = document.getElementById("clearBtn");
const themeBtn = document.getElementById("themeBtn");
const langBtn = document.getElementById("langBtn");
const errorCountEl = document.getElementById("errorCount");

const THEME_STORAGE_KEY = "explain-error-theme";
const LANG_STORAGE_KEY = "explain-error-lang";

let currentErrors = [];
let renderRunId = 0;

const aiExplanationCache = new Map();
const MIN_AI_EXPLANATION_LENGTH = 60;

const translations = {
  en: {
    captured: "captured",
    clear: "Clear",
    dark: "Dark",
    light: "Light",
    emptyTitle: "All quiet here",
    emptyText: "Refresh the page or trigger an error, then reopen this popup.",
    eyebrow: "Runtime watcher",
    loading: "Loading errors...",
    noAccess: "Cannot access this tab. Open a normal webpage to capture errors.",
    noErrors: "No captured JavaScript errors on this tab.",
    noExplanation: "No explanation available.",
    showing: (count) => `Showing ${count} captured error${count === 1 ? "" : "s"} on this tab.`,
    subtitle: "Catch page errors and translate them into plain English.",
    title: "Explain Error",
    unknownError: "Unknown error",
    unknownSource: "(inline/unknown source)",
    askingGemini: "Asking Gemini for a simple explanation...",
    langButton: "عربي",
    explanations: {
      notDefined: "You are using a variable or function name that has not been declared or is out of scope.",
      notFunction: "You are trying to call something with () that is not actually a function. Check the variable's value and type.",
      undefinedProperty: "Code tried to access a property on undefined. Verify the object exists before reading its fields.",
      resourceFailed: "A resource failed to load. Check the file path, URL, or server response.",
      promise: "A promise failed without a catch handler. Add error handling with catch or try/catch.",
      generic: "This error is not in the common list yet. Read the message and stack trace to locate the failing code path."
    }
  },
  ar: {
    captured: "تم التقاطها",
    clear: "مسح",
    dark: "داكن",
    light: "فاتح",
    emptyTitle: "كل شيء هادئ",
    emptyText: "حدّث الصفحة أو شغّل خطأ، ثم افتح النافذة مرة أخرى.",
    eyebrow: "مراقب الأخطاء",
    loading: "جاري تحميل الأخطاء...",
    noAccess: "لا يمكن الوصول إلى هذا التبويب. افتح صفحة ويب عادية لالتقاط الأخطاء.",
    noErrors: "لا توجد أخطاء JavaScript ملتقطة في هذا التبويب.",
    noExplanation: "لا يوجد شرح متاح.",
    showing: (count) => `يتم عرض ${count} خطأ ملتقط في هذا التبويب.`,
    subtitle: "يلتقط أخطاء الصفحة ويشرحها بلغة بسيطة.",
    title: "اشرح الخطأ",
    unknownError: "خطأ غير معروف",
    unknownSource: "(مصدر داخلي أو غير معروف)",
    askingGemini: "جاري طلب شرح بسيط من Gemini...",
    langButton: "English",
    explanations: {
      notDefined: "أنت تستخدم متغيرًا أو دالة لم يتم تعريفها، أو أنها خارج النطاق الحالي.",
      notFunction: "أنت تحاول استدعاء قيمة باستخدام () لكنها ليست دالة. تحقق من نوع وقيمة المتغير.",
      undefinedProperty: "الكود يحاول قراءة خاصية من قيمة undefined. تأكد أن الكائن موجود قبل استخدامه.",
      resourceFailed: "فشل تحميل ملف أو مورد. تحقق من المسار أو الرابط أو استجابة الخادم.",
      promise: "يوجد Promise فشل بدون معالج أخطاء. أضف catch أو استخدم try/catch.",
      generic: "هذا الخطأ غير موجود في القائمة الشائعة بعد. اقرأ الرسالة وتتبع المكدس لمعرفة مكان المشكلة."
    }
  }
};

function t(key) {
  return translations[getLanguage()][key];
}

function setStatus(message) {
  statusEl.textContent = message;
}

function getLanguage() {
  return localStorage.getItem(LANG_STORAGE_KEY) === "ar" ? "ar" : "en";
}

function applyLanguage(lang) {
  localStorage.setItem(LANG_STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (typeof translations[lang][key] === "string") {
      element.textContent = translations[lang][key];
    }
  });
  langBtn.textContent = translations[lang].langButton;
  applyTheme(document.documentElement.dataset.theme || getPreferredTheme());
}

function toggleLanguage() {
  applyLanguage(getLanguage() === "ar" ? "en" : "ar");
  renderErrors(currentErrors);
}

function getPreferredTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  if (savedTheme === "light" || savedTheme === "dark") {
    return savedTheme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === "dark" ? t("light") : t("dark");
  themeBtn.setAttribute("aria-pressed", String(theme === "dark"));
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  applyTheme(nextTheme);
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function translateExplanation(error) {
  const text = String(error?.message || "").toLowerCase();
  const type = String(error?.type || "").toLowerCase();
  const explanations = translations[getLanguage()].explanations;

  if (text.includes("is not defined")) {
    return explanations.notDefined;
  }

  if (text.includes("is not a function")) {
    return explanations.notFunction;
  }

  if (text.includes("cannot read properties of undefined") || text.includes("cannot read property")) {
    return explanations.undefinedProperty;
  }

  if (text.includes("resource failed to load") || type.includes("resource")) {
    return explanations.resourceFailed;
  }

  if (type.includes("unhandledrejection")) {
    return explanations.promise;
  }

  return getLanguage() === "ar" ? explanations.generic : error.explanation || explanations.generic;
}

function renderTextWithLineBreaks(element, text) {
  element.textContent = "";
  String(text || "")
    .split("\n")
    .forEach((line, index) => {
      if (index > 0) {
        element.appendChild(document.createElement("br"));
      }

      element.appendChild(document.createTextNode(line));
    });
}

function getErrorCacheKey(error) {
  return [
    error?.type || "",
    error?.message || "",
    error?.source || "",
    error?.line ?? "",
    error?.column ?? ""
  ].join("|");
}

function sendMessageAsync(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

async function getAIExplanation(error) {
  const cacheKey = getErrorCacheKey(error);
  if (aiExplanationCache.has(cacheKey)) {
    return aiExplanationCache.get(cacheKey);
  }

  const response = await sendMessageAsync({
    type: "EXPLAIN_ERROR_WITH_GEMINI",
    error
  });

  const explanation = String(response?.explanation || "").trim();
  const hasRequiredSections =
    explanation.includes("Cause:") &&
    explanation.includes("Fix:") &&
    explanation.includes("Example:");

  if (!response || !response.ok || explanation.length < MIN_AI_EXPLANATION_LENGTH || !hasRequiredSections) {
    throw new Error(response?.error || "AI explanation failed.");
  }

  aiExplanationCache.set(cacheKey, explanation);
  return explanation;
}

async function updateCardWithAI(error, explanationEl, runId) {
  if (getLanguage() !== "en") {
    renderTextWithLineBreaks(explanationEl, translateExplanation(error));
    return;
  }

  const fallbackExplanation = translateExplanation(error) || t("noExplanation");
  const cacheKey = getErrorCacheKey(error);

  if (aiExplanationCache.has(cacheKey)) {
    renderTextWithLineBreaks(explanationEl, aiExplanationCache.get(cacheKey));
    return;
  }

  renderTextWithLineBreaks(explanationEl, "Explaining with AI...");

  try {
    const aiExplanation = await getAIExplanation(error);
    if (runId === renderRunId) {
      renderTextWithLineBreaks(explanationEl, aiExplanation);
    }
  } catch (_) {
    if (runId === renderRunId) {
      renderTextWithLineBreaks(explanationEl, fallbackExplanation);
    }
  }
}

function createErrorCard(error, index) {
  const card = document.createElement("article");
  card.className = "error-card";

  const badge = document.createElement("span");
  badge.className = "error-badge";
  badge.textContent = error.type || "error";

  const title = document.createElement("h2");
  title.className = "error-title";
  title.textContent = error.message || t("unknownError");

  const explanation = document.createElement("p");
  explanation.className = "error-explanation";
  renderTextWithLineBreaks(explanation, translateExplanation(error) || t("noExplanation"));

  const aiLabel = document.createElement("div");
  aiLabel.className = "ai-label";
  aiLabel.textContent = "\u{1F916} AI Explanation";

  const meta = document.createElement("div");
  meta.className = "error-meta";
  const sourcePart = error.source ? `${error.source}` : t("unknownSource");
  const linePart = error.line != null ? `:${error.line}` : "";
  const columnPart = error.column != null ? `:${error.column}` : "";
  const timePart = formatTime(error.timestamp);
  meta.textContent = `${sourcePart}${linePart}${columnPart}${timePart ? ` | ${timePart}` : ""}`;

  card.style.setProperty("--delay", `${index * 35}ms`);
  card.appendChild(badge);
  card.appendChild(title);
  card.appendChild(aiLabel);
  card.appendChild(explanation);
  card.appendChild(meta);

  return { card, error, explanationEl: explanation };
}

async function processErrorsList(renderedErrors, runId) {
  for (const renderedError of renderedErrors) {
    if (runId !== renderRunId) {
      return;
    }

    await updateCardWithAI(renderedError.error, renderedError.explanationEl, runId);
  }
}

function renderErrors(errors) {
  renderRunId += 1;
  const runId = renderRunId;
  currentErrors = Array.isArray(errors) ? errors : [];
  errorsListEl.innerHTML = "";
  const count = currentErrors.length;
  errorCountEl.textContent = String(count);

  if (count === 0) {
    setStatus(t("noErrors"));
    const emptyState = document.createElement("article");
    emptyState.className = "empty-state";
    emptyState.innerHTML = `
      <div class="empty-orb"></div>
      <h2>${t("emptyTitle")}</h2>
      <p>${t("emptyText")}</p>
    `;
    errorsListEl.appendChild(emptyState);
    return;
  }

  setStatus(t("showing")(count));

  const renderedErrors = currentErrors.map((error, index) => createErrorCard(error, index));
  renderedErrors.forEach(({ card }) => {
    errorsListEl.appendChild(card);
  });
  processErrorsList(renderedErrors, runId);
}

function requestErrors() {
  chrome.runtime.sendMessage({ type: "GET_ERRORS_ACTIVE_TAB" }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus(`Error: ${chrome.runtime.lastError.message}`);
      errorsListEl.innerHTML = "";
      return;
    }

    if (!response || !response.ok) {
      setStatus(response?.error || t("noAccess"));
      errorsListEl.innerHTML = "";
      return;
    }

    const errors = Array.isArray(response.errors) ? response.errors : [];
    renderErrors(errors);
  });
}

function clearErrors() {
  chrome.runtime.sendMessage({ type: "CLEAR_ERRORS_ACTIVE_TAB" }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus(`Error: ${chrome.runtime.lastError.message}`);
      return;
    }

    if (!response || !response.ok) {
      setStatus(response?.error || "Could not clear errors on this tab.");
      return;
    }

    renderErrors([]);
  });
}

clearBtn.addEventListener("click", clearErrors);
themeBtn.addEventListener("click", toggleTheme);
langBtn.addEventListener("click", toggleLanguage);
applyTheme(getPreferredTheme());
applyLanguage(getLanguage());
document.addEventListener("DOMContentLoaded", requestErrors);
