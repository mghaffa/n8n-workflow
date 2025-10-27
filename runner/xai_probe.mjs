// runner/xai_probe.mjs
const KEY = process.env.XAI_API_KEY?.trim();
const MODEL = (process.env.XAI_MODEL || "grok-2-mini").trim();
const ENDPOINT = (process.env.XAI_ENDPOINT || "chat").trim(); // "chat" or "responses"

if (!KEY) { console.error("XAI_API_KEY missing"); process.exit(2); }

const url = ENDPOINT === "responses"
  ? "https://api.x.ai/v1/responses"
  : "https://api.x.ai/v1/chat/completions";

const body = ENDPOINT === "responses"
  ? {
      model: MODEL,
      input: [
        { role: "system", content: "Return JSON {ok:true} and nothing else." },
        { role: "user", content: "Ping." }
      ],
      response_format: { type: "json_object" }
    }
  : {
      model: MODEL,
      messages: [
        { role: "system", content: "Return JSON: {\"ok\":true} only." },
        { role: "user", content: "Ping." }
      ],
      response_format: { type: "json_object" }
    };

console.log(`[probe] POST ${url}`);
console.log(`[probe] Model=${MODEL} | Endpoint=${ENDPOINT}`);

const r = await fetch(url, {
  method: "POST",
  headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

console.log(`[probe] HTTP ${r.status}`);
const text = await r.text();
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }

if (r.status === 401) { console.error("[probe] ERROR: Auth header missing/invalid."); process.exit(2); }
if (r.status === 403) { console.error("[probe] ERROR: Forbidden — your key lacks endpoint/model ACLs."); process.exit(3); }
if (r.status >= 400) { console.error("[probe] ERROR: HTTP " + r.status); process.exit(4); }
