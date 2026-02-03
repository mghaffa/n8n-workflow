
// runner/gpt_probe_v1.mjs  (supports Groq or xAI via whichever key is present)
const groqKey = (process.env.GROQ_API_KEY || "").trim();
const xaiKey  = (process.env.XAI_API_KEY  || "").trim();
const gptKey = (process.env.OPENAI_API_KEY || "").trim();

let base, key, model;
if (gptKey) {
  key   = gptKey;
  base  = (process.env.OPENAI_BASE  || "https://api.groq.com/openai/v1").trim();
  model = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
} else if (xaiKey) {
  key   = xaiKey;
  base  = (process.env.XAI_BASE   || "https://api.x.ai/v1").trim();
  model = (process.env.XAI_MODEL  || "grok-4-fast-reasoning").trim();
} else {
  console.error("[probe] Missing OPENAI_API_KEY or XAI_API_KEY");
  process.exit(2);
}

const url = `${base}/chat/completions`;
console.log("[probe] POST", url);
console.log(`[probe] Model=${model} | Base=${base}`);

const body = {
  model,
  messages: [
    { role: "system", content: "Reply only with {\"ok\":true}" },
    { role: "user",   content: "Return exactly {\"ok\":true}" }
  ],
  temperature: 0
};

const r = await fetch(url, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(body)
});

console.log("[probe] HTTP", r.status);
let data = {};
try { data = await r.json(); } catch {}

if (r.ok) {
  console.log("[probe] OK:", data?.choices?.[0]?.message?.content ?? JSON.stringify(data));
  process.exit(0);
}

const msg = data?.error?.message || data?.error || data?.message || JSON.stringify(data);
console.error(msg || "(no error body)");
if (r.status === 401) process.exit(2);
if (r.status === 403) {
  console.error("[probe] ERROR: Forbidden — key lacks ACLs or team has no credits.");
  process.exit(3);
}
process.exit(4);
