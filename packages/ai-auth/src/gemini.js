// How to call Gemini, both ways of paying for it.
//
// Two wires that look like one and are not:
//
//   * **A metered key** (`gemini`) speaks Google AI Studio's public API —
//     `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=…`,
//     with the request body at the top level.
//   * **A Google subscription** (`gemini-cli`, the Antigravity `agy` login) does not
//     speak that API at all. It goes to the internal Cloud Code endpoint
//     (`…/v1internal:generateContent`), authenticates with a bearer token, and wraps the
//     same request in `{ model, project, request: { … } }`. Treating the two as
//     interchangeable is the bug this file exists to not repeat.
//
// The model ids differ too: the catalogue offers `gemini-3.8-flash-high`, AI Studio wants
// `gemini-3.8-flash`, and Cloud Code wants `gemini-3.8-flash-tiered` with the effort sent
// as a thinking level. Each of those mappings was read off a live endpoint.

import { sanitizeGeminiFunctionParameters } from "./gemini-schema.js";

/** Google AI Studio, for metered API keys. */
export const GEMINI_STUDIO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Google's shared consumer project — fine in a request body, never as x-goog-user-project. */
export const GOOGLE_ENTERPRISE_CLOUD_CODE_PROJECT = "aicode-consumers";

export const CLOUD_CODE_PROD_BASE_URL = "https://cloudcode-pa.googleapis.com/v1internal";
export const CLOUD_CODE_DAILY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal";

/**
 * Gemini 3.8 Flash on Cloud Code is one model, `gemini-3.8-flash-tiered`, whose effort is
 * a request setting (`generationConfig.thinkingConfig.thinkingLevel`), not part of its id.
 * Verified 2026-10-18 against a personal agy login: `fetchAvailableModels` lists only the
 * tiered id, `gemini-3.8-flash-high` (and -low/-medium) answer 404, and the tiered id
 * answers 200 with 0 / 59 / 111 thought tokens at thinkingLevel low / medium / high.
 */
const GEMINI_38_FLASH_RE = /^gemini-3\.8-flash(?:-(low|medium|high))?$/i;
export const GEMINI_38_FLASH_TIERED = "gemini-3.8-flash-tiered";

const bareModel = (model) => {
  const trimmed = String(model ?? "").trim();
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
};

/** A metered Google AI Studio key. */
export function geminiKeyOptions(apiKey, baseUrl = GEMINI_STUDIO_BASE_URL) {
  return { apiKey, baseURL: baseUrl };
}

/**
 * The id AI Studio knows for a catalogue id. The -low/-medium/-high suffix is how the
 * catalogue spells an effort tier; AI Studio has no such models and 404s on them.
 */
export function geminiStudioModelId(model) {
  return bareModel(model).replace(/-(low|medium|high)$/i, "");
}

/**
 * The thinking level a catalogue id asks for on Cloud Code, or undefined when the id is
 * not a tiered model. A Gemini 3.8 Flash id without a tier runs at medium.
 */
export function antigravityThinkingLevel(model) {
  const match = GEMINI_38_FLASH_RE.exec(bareModel(model));
  if (!match) return undefined;
  return match[1]?.toLowerCase() ?? "medium";
}

/**
 * Bare Cloud Code model ids (agy). Prefixing `models/` 404s on the daily host. Maps the
 * catalogue's ids to the ones `daily-cloudcode-pa` knows.
 */
export function normalizeAntigravityModelId(model) {
  const bare = bareModel(model);
  if (bare === "gemini-3.1-pro" || bare === "gemini-3-pro") return "gemini-3.1-pro-low";
  if (bare === "gemini-4-argon") return "gemini-4-argon-medium";
  if (GEMINI_38_FLASH_RE.test(bare) || bare === GEMINI_38_FLASH_TIERED) return GEMINI_38_FLASH_TIERED;
  if (bare === "gemini-3.7-flash" || bare === "gemini-3.7-flash-tiered") return "gemini-3.7-flash-medium";
  if (bare === "gemini-3.6-flash") return "gemini-3.6-flash-medium";
  if (/^gemini-3\.(6|7)-flash-(low|medium|high)$/i.test(bare)) return bare.toLowerCase();
  // Earlier minor flash aliases (`gemini-3.1-flash`, `gemini-3.2-flash-lite`, …).
  if (/^gemini-3\.[0-4]-flash/i.test(bare)) return "gemini-3-flash";
  return bare;
}

/**
 * Strip the enterprise shared project from header use. Personal tokens 403 on
 * `x-goog-user-project: aicode-consumers` (body-only is fine).
 */
export function sanitizePersonalCloudCodeProject(projectId) {
  const trimmed = typeof projectId === "string" ? projectId.trim() : "";
  if (!trimmed || trimmed === GOOGLE_ENTERPRISE_CLOUD_CODE_PROJECT) return null;
  return trimmed;
}

/**
 * The Antigravity client version Cloud Code calls present as (in User-Agent).
 *
 * Google gates on it, and not with an error: below its floor the endpoint answers 200 and
 * the "model output" is an upgrade notice ("This version of Antigravity is no longer
 * supported…"). 1.21.9 hit that in November 2026. ANTIGRAVITY_CLIENT_VERSION overrides
 * the default without a release when the floor moves again; isAntigravityUpgradeNotice
 * is what notices it happened.
 */
export const ANTIGRAVITY_CLIENT_VERSION = "2.29.0";

export function antigravityClientVersion() {
  const fromEnv = process.env.ANTIGRAVITY_CLIENT_VERSION?.trim();
  return fromEnv && /^\d+\.\d+\.\d+$/.test(fromEnv) ? fromEnv : ANTIGRAVITY_CLIENT_VERSION;
}

/** True when Cloud Code's "answer" is really its refusal of an outdated client. */
export function isAntigravityUpgradeNotice(text) {
  return /version of Antigravity is no longer supported|antigravity\.google\/download/i.test(String(text ?? ""));
}

/**
 * Gemini on a Google subscription (the Antigravity login), via Cloud Code.
 *
 * Always the **daily** host unless a base URL is passed: consumer tokens succeed there,
 * while prod answers a healthy personal account with a false 429 RESOURCE_EXHAUSTED.
 * Never put `aicode-consumers` on `x-goog-user-project`.
 */
export function antigravityCliOptions(identity, baseUrl) {
  const headerProjectId = sanitizePersonalCloudCodeProject(identity.projectId);
  return {
    authToken: identity.accessToken,
    baseURL: baseUrl ?? CLOUD_CODE_DAILY_BASE_URL,
    projectId: headerProjectId ?? undefined,
    defaultHeaders: {
      authorization: `Bearer ${identity.accessToken}`,
      "content-type": "application/json",
      "user-agent": `antigravity/${antigravityClientVersion()} linux/amd64`,
      ...(headerProjectId ? { "x-goog-user-project": headerProjectId } : {}),
    },
  };
}

/**
 * A generation payload for the Cloud Code endpoint. Its `.request` is also exactly the
 * body AI Studio takes, which is how the metered-key path builds its body too.
 *
 * @param {string} model the catalogue id the caller chose
 * @param {object[]|string} contents Gemini contents, or one user message
 * @param {object} [options]
 * @param {string} [options.projectId]
 * @param {string} [options.systemInstruction]
 * @param {string} [options.userPromptId]
 * @param {object[]} [options.tools] `{ name, description, input_schema|parameters }`
 * @param {"none"} [options.toolChoice] forbid tool calls this turn
 * @param {boolean} [options.includeThoughts] ask for thought summaries
 */
export function toCodeAssistRequest(model, contents, options = {}) {
  const normalizedContents = typeof contents === "string"
    ? [{ role: "user", parts: [{ text: contents }] }]
    : contents;

  const wireModel = normalizeAntigravityModelId(model);
  // A tiered model's effort travels as a thinking level, read from the id the caller chose.
  const thinkingLevel = wireModel === GEMINI_38_FLASH_TIERED ? antigravityThinkingLevel(model) : undefined;
  const tools = options.tools ?? [];

  return {
    model: wireModel,
    ...(options.projectId ? { project: options.projectId } : {}),
    ...(options.userPromptId ? { user_prompt_id: options.userPromptId } : {}),
    request: {
      contents: normalizedContents,
      ...(options.systemInstruction
        ? { systemInstruction: { role: "system", parts: [{ text: options.systemInstruction }] } }
        : {}),
      ...(tools.length > 0 ? {
        tools: [{
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            ...((t.input_schema || t.parameters)
              ? { parameters: sanitizeGeminiFunctionParameters(t.input_schema || t.parameters) }
              : {}),
          })),
        }],
        ...(options.toolChoice === "none" ? { toolConfig: { functionCallingConfig: { mode: "NONE" } } } : {}),
      } : {}),
      ...(thinkingLevel || options.includeThoughts
        ? {
            generationConfig: {
              thinkingConfig: {
                ...(thinkingLevel ? { thinkingLevel } : {}),
                ...(options.includeThoughts ? { includeThoughts: true } : {}),
              },
            },
          }
        : {}),
    },
  };
}
