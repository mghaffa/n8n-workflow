// runner/xai_probe.mjs
// Minimal xAI (Grok) connectivity probe with NO dependencies.
// Usage (via GitHub Actions): set XAI_API_KEY secret, then run with inputs.

const key      = (process.env.XAI_API_KEY || "").trim();
const model    = (process.env.XAI_MODEL || "grok-2-mini").trim();
const scheme   = (process.env.XAI_AUTH_SCHEME || "Bearer").trim();   // correct: "Bearer"
const endpoint = (process.env.XAI_ENDPOINT || "chat").trim();        // "chat" | "responses"

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

const body = endpoint === "responses"
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
  console.log(`[probe] Model=${model} | Auth-Scheme=${scheme} | Endpoint=${endpoint}`);
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    console.log(`[probe] HTTP ${res.status}`);
    if (res.status === 200) {
      let sample = "";
      try {
        const data = JSON.parse(text);
        sample =
          data?.choices?.[0]?.message?.content ??
          data?.output?.[0]?.content?.[0]?.text ??
          text.slice(0, 160);
      } catch {
        sample = text.slice(0, 160);
      }
      console.log("[probe] OK. Sample:", String(sample).slice(0, 120));
      process.exit(0);
    } else {
      let errMsg = "Unknown";
      try { errMsg = JSON.parse(text)?.error?.message || res.statusText || text.slice(0, 200); }
      catch { errMsg = res.statusText || text.slice(0, 200); }
      console.error("[probe] ERROR:", errMsg);
      if (res.status === 401) process.exit(2);  // bad key / bad scheme
      if (res.status === 403) process.exit(3);  // not entitled to model
      process.exit(4);                          // other HTTP error
    }
  } catch (e) {
    console.error("[probe] EXCEPTION:", e.message);
    process.exit(5);
  }
})();
