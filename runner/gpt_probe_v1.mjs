// runner/gpt_probe_v1.mjs
// Probes OpenAI / Groq / xAI depending on which key is present.

const openaiKey = (process.env.OPENAI_API_KEY || "").trim();
const groqKey   = (process.env.GROQ_API_KEY   || "").trim();
const xaiKey    = (process.env.XAI_API_KEY    || "").trim();

let base, key, model, provider;

if (openaiKey) {
  provider = "openai";
  key   = openaiKey;
  base  = (process.env.OPENAI_BASE  || "https://api.openai.com/v1").trim();
  model = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
} else if (groqKey) {
  provider = "groq";
  key   = groqKey;
  base  = (process.env.GROQ_BASE  || "https://api.groq.com/openai/v1").trim();
  model = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();
} else if (xaiKey) {
  provider = "xai";
  key   = xaiKey;
  base  = (process.env.XAI_BASE  || "https://api.x.ai/v1").trim();
  model = (process.env.XAI_MODEL || "grok-4-fast-reasoning").trim();
} else {
  console.error("[probe] Missing OPENAI_API_KEY or GROQ_API_KEY or XAI_API_KEY");
  process.exit(2);
}

const url = `${base.replace(/\/$/, "")}/chat/completions`;
console.log("[probe] Provider:", provider);
console.log("[probe] POST", url);
console.log(`[probe] Model=${model} | Base=${base}`);

const body = {
  model,
  messages: [
    { role: "system", content: 'Reply only with {"ok":true}' },
    { role: "user",   content: 'Return exactly {"ok":true}' }
  ],
  temperature: 0
};

// add a timeout so CI doesn't hang forever
const controller = new AbortController();
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 20000);
const t = setTimeout(() => controller.abort(), timeoutMs);

let r;
try {
  r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: controller.signal
  });
} catch (e) {
  clearTimeout(t);
  console.error("[probe] Fetch failed:", e?.message || e);
  process.exit(5);
}
clearTimeout(t);

console.log("[probe] HTTP", r.status);

let data = null;
const raw = await r.text();
try { data = JSON.parse(raw); } catch { /* keep raw */ }

if (r.ok) {
  const content = data?.choices?.[0]?.message?.content;
  console.log("[probe] OK:", content ?? raw);
  process.exit(0);
}

const msg =
  data?.error?.message ||
  data?.error ||
  data?.message ||
  raw ||
  "(no error body)";

console.error("[probe] ERROR:", msg);

if (r.status === 401) process.exit(2);
if (r.status === 403) process.exit(3);
process.exit(4);
