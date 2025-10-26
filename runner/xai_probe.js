// runner/xai_probe.js
// Minimal connectivity probe for xAI Grok from GitHub Actions.
// Tries the /v1/chat/completions endpoint and prints a concise result.

import axios from "axios";

const key   = (process.env.XAI_API_KEY || "").trim();
const model = (process.env.XAI_MODEL || "grok-2-mini").trim();
// Valid scheme is "Bearer"; we also allow testing a wrong scheme to prove it fails.
const scheme = (process.env.XAI_AUTH_SCHEME || "Bearer").trim();
const endpoint = (process.env.XAI_ENDPOINT || "chat").trim(); // "chat" or "responses"

if (!key) {
  console.error("[probe] XAI_API_KEY is missing.");
  process.exit(10);
}

const url = endpoint === "responses"
  ? "https://api.x.ai/v1/responses"
  : "https://api.x.ai/v1/chat/completions";

const headers = {
  "Authorization": `${scheme} ${key}`,
  "Content-Type": "application/json"
};

const body =
  endpoint === "responses"
    // NOTE: responses endpoint body is OpenAI-style; you may not have this enabled.
    ? {
        model,
        input: [
          {
            role: "user",
            content: [{ type: "text", text: "Ping from GitHub Actions. Reply 'ok'." }]
          }
        ],
        max_output_tokens: 64
      }
    : {
        model,
        messages: [
          { role: "system", content: "You are a simple echo bot. Reply with 'ok'." },
          { role: "user", content: "Ping from GitHub Actions." }
        ],
        temperature: 0,
        max_tokens: 32
      };

(async () => {
  console.log(`[probe] POST ${url}`);
  console.log(`[probe] Model=${model} | Auth-Scheme=${scheme}`);
  try {
    const r = await axios.post(url, body, { headers, timeout: 30000, validateStatus: () => true });
    console.log(`[probe] HTTP ${r.status}`);
    if (r.status === 200) {
      // Try to show a tiny slice of the reply without dumping the whole payload
      const msg =
        r.data?.choices?.[0]?.message?.content ??
        r.data?.output?.[0]?.content?.[0]?.text ??
        JSON.stringify(r.data).slice(0, 160);
      console.log("[probe] OK. Sample:", String(msg).slice(0, 120));
      process.exit(0);
    } else {
      const err = r.data?.error?.message || r.statusText || "Unknown";
      console.error("[probe] ERROR:", err);
      // Friendly exit codes
      if (r.status === 401) process.exit(2);    // Unauthorized (bad key / bad scheme)
      if (r.status === 403) process.exit(3);    // Forbidden (no entitlement to model)
      process.exit(4);                          // Other HTTP error
    }
  } catch (e) {
    console.error("[probe] EXCEPTION:", e.message);
    process.exit(5);
  }
})();
