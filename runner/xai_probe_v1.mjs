// runner/xai_probe.mjs
// Minimal xAI connectivity probe (no npm deps). Uses Node 18+ global fetch.
// Exits with:
//   0 -> success
//   2 -> auth header missing/invalid
//   3 -> forbidden/no credits/permissions
//   4 -> other HTTP error

const key   = (process.env.XAI_API_KEY || "").trim();
const model = (process.env.XAI_MODEL || "grok-4-fast-reasoning").trim();

if (!key) { console.error("[probe] XAI_API_KEY missing"); process.exit(2); }

const body = {
  model,
  messages: [
    { role: "system", content: "Return a strict JSON object: {ok:true}" },
    { role: "user", content: "Say nothing else; just the JSON object." }
  ],
  response_format: { type: "json_object" }
};

const url = "https://api.x.ai/v1/chat/completions";
console.log("[probe] POST", url);
console.log(`[probe] Model=${model} | Endpoint=chat`);

const r = await fetch(url, {
  method: "POST",
  headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify(body)
});
console.log("[probe] HTTP", r.status);
let data = {};
try { data = await r.json(); } catch {}

if (r.status === 200) {
  const txt = data?.choices?.[0]?.message?.content || "{}";
  console.log("[probe] OK:", txt);
  process.exit(0);
}

const msg = data?.error || data?.message || JSON.stringify(data);
console.error(msg || "(no error body)");
if (r.status === 401) process.exit(2);
if (r.status === 403) {
  console.error("[probe] ERROR: Forbidden — your key lacks endpoint/model ACLs or team has no credits.");
  process.exit(3);
}
process.exit(4);
