// runner/xai_models.mjs
const KEY = process.env.XAI_API_KEY?.trim();
if (!KEY) { console.error("XAI_API_KEY missing"); process.exit(2); }

const headers = { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" };

const endpoints = [
  ["models", "GET", "https://api.x.ai/v1/models"],                    // shows models you can access
  ["endpoints", "GET", "https://management-api.x.ai/endpoints"],      // may require a management key; ignore if 401/403
];

(async () => {
  for (const [name, method, url] of endpoints) {
    try {
      console.log(`[models] ${method} ${url}`);
      const r = await fetch(url, { method, headers });
      console.log(`[models] HTTP ${r.status}`);
      const text = await r.text();
      try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
      catch { console.log(text); }
    } catch (e) {
      console.error(`[models] error: ${e.message}`);
      process.exit(3);
    }
  }
})();
