// index-v5.js
// Bullet Catalyst (GitHub runner) — OpenAI (GPT) + xAI (Grok) + Groq screen with clear fallbacks.
// Flow: 1) Fetch RSS -> 2) Parse tickers -> 3) GPT + Grok + Groq -> 4) Merge/score -> 5) Markdown -> 6) Email

import axios from "axios";
import nodemailer from "nodemailer";
import { XMLParser } from "fast-xml-parser";
import he from "he";

/* ---------------- env helpers ---------------- */
function envTrim(name, def = "") {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : def;
}
function mask(s) {
  if (!s) return "MISSING";
  if (s.length <= 8) return "****";
  return s.slice(0, 3) + "…" + s.slice(-4);
}
const asBool = (v, d=false) => {
  if (v == null) return d;
  const s = String(v).trim().toLowerCase();
  return ["1","true","yes","y","on"].includes(s);
};

/* ---------------- debug helpers ---------------- */
// Runtime override: call setGroqDebug(true) anywhere before/while running.
export function setGroqDebug(on = true) {
  globalThis.__GROQ_DEBUG__ = !!on;
}

// Single source of truth for the toggle.
// Priority: runtime flag -> CLI flags -> env var (LOG_RAW_PAYLOADS)
function shouldLogGroq() {
  if (globalThis.__GROQ_DEBUG__ === true) return true;
  if (process.argv.includes('--debug-groq') || process.argv.includes('--debug') || process.argv.includes('-dg')) return true;
  return ["1","true","yes","y","on"].includes(String(process.env.LOG_RAW_PAYLOADS||"").trim().toLowerCase());
}

// >>> ADD THIS LINE to force debug for manual runs:
setGroqDebug(true);

console.log("[env] GROQ_DEBUG:", shouldLogGroq());

// Pretty-print (or raw) Groq payloads when debug is enabled.
function logGroqRaw(content) {
  // Default to pretty (multiline). You can force raw with GROQ_LOG_MODE=raw
  const mode = String(process.env.GROQ_LOG_MODE || "pretty").toLowerCase();

  if (mode === "raw") {
    console.log("[groq] raw content:", content);
    return;
  }

  // pretty
  try {
    const pretty = JSON.stringify(JSON.parse(String(content)), null, 2);
    console.log("[groq] raw content:", pretty);
  } catch {
    // If not valid JSON, just print as-is (still full, not truncated)
    console.log("[groq] raw content:", content);
  }
}


/* ---------------- debug toggle (suggested fix) ---------------- */
const LOG_RAW_PAYLOADS = asBool(process.env.LOG_RAW_PAYLOADS, false);      //* make it True to get debug for groq *//
const preview = (s, n = 600) => {
  const t = String(s ?? "").replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/* ---------------- config ---------------- */
const OPENAI_API_KEY = envTrim("OPENAI_API_KEY");
const XAI_API_KEY    = envTrim("XAI_API_KEY");
const GROQ_API_KEY   = envTrim("GROQ_API_KEY");

const OPENAI_MODEL   = envTrim("OPENAI_MODEL", "gpt-4o");
const XAI_MODEL      = envTrim("XAI_MODEL", "grok-4-fast-reasoning");
const GROQ_MODEL     = envTrim("GROQ_MODEL", "llama-3.3-70b-versatile");
const GROQ_BASE      = envTrim("GROQ_BASE", "https://api.groq.com/openai/v1");

const EMAIL_FROM     = envTrim("EMAIL_FROM");
const EMAIL_TO       = envTrim("EMAIL_TO");
const SMTP_HOST      = envTrim("SMTP_HOST");
const SMTP_PORT_RAW  = envTrim("SMTP_PORT");
const SMTP_USER      = envTrim("SMTP_USER");
const SMTP_PASS      = envTrim("SMTP_PASS");

const DRY_RUN = process.argv.includes("--dry-run");
// Back-compat var name + generalized flag:
const HEURISTIC_FALLBACK = asBool(process.env.HEURISTIC_FALLBACK ?? process.env.GROK_HEURISTIC_FALLBACK, true);

console.log("[env] OPENAI_API_KEY:", mask(OPENAI_API_KEY));
console.log("[env] XAI_API_KEY   :", mask(XAI_API_KEY));
console.log("[env] GROQ_API_KEY  :", mask(GROQ_API_KEY));
console.log("[env] OPENAI_MODEL  :", OPENAI_MODEL);
console.log("[env] XAI_MODEL     :", XAI_MODEL);
console.log("[env] GROQ_MODEL    :", GROQ_MODEL);
console.log("[env] HEURISTIC_FALLBACK:", HEURISTIC_FALLBACK);

/* ---------------- small utils ---------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stripHtml = (s) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const decode = (s) => he.decode(String(s || ""));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pick = (arr, n) => arr.slice(0, n);
function uniqueCaseFold(arr){const seen=new Set();const out=[];for(const v of arr){const k=String(v).toLowerCase().trim();if(!k||seen.has(k))continue;seen.add(k);out.push(v);}return out;}

/* naive name→ticker map */
const NAME2TICKER = Object.entries({
  'nvidia': 'NVDA', 'amd': 'AMD', 'advanced micro devices': 'AMD',
  'oracle': 'ORCL', 'broadcom': 'AVGO', 'palantir': 'PLTR', 'cloudflare': 'NET',
  'amazon': 'AMZN', 'alphabet': 'GOOGL', 'google': 'GOOGL', 'microsoft': 'MSFT',
  'kla': 'KLAC', 'kla corporation': 'KLAC', 'ibm': 'IBM', 'apple': 'AAPL',
  'tqqq': 'TQQQ', 'intel': 'INTC', 'bulz': 'BULZ', 'costco': 'COST', 'cost': 'COST',
  'tesla': 'TSLA', 'meta': 'META', 'facebook': 'META', 'servicenow': 'NOW',
  'netflix': 'NFLX', 'hims': 'HIMS', 'natera': 'NTRA', 'datadog': 'DDOG',
  'taiwan semiconductor': 'TSM', 'tsmc': 'TSM', 'micron': 'MU', 'salesforce': 'CRM',
  'teradyne': 'TEM', 'rocket lab': 'RKLB', 'crowdstrike': 'CRWD', 'uvxy': 'UVXY',
  'unitedhealth': 'UNH', 'jpmorgan': 'JPM', 'abbott': 'ABT', 'beyond meat': 'BYND',
  'ferrari': 'RACE', 'sofi': 'SOFI', 'dell': 'DELL', 'upstart': 'UPST',
  'gold': 'GLD', 'gldm': 'GLDM', 'shiny': 'SHNY', 'msci': 'MSCI',
  'cameco': 'CCJ', 'shopify': 'SHOP', 'ionq': 'IONQ', 'regetti': 'REGTI',
  'quantum computing': 'QBTS', 'qtum': 'QTUM', 'qubt': 'QUBT',
  'laesa': 'LAES', 'arqit': 'ARQQ', 'holoride': 'HOLO'
});
const TICKER_BLACKLIST = new Set([
  "IN","WITH","AND","THE","FOR","FROM","OVER","AFTER","BEFORE","FIRST","SECOND","THIRD",
  "NEWS","CNBC","CNN","TECH","STOCK","MARKET","EARNINGS","RESULTS","SHARES","OFF","S","INTEL"
]);

function extractTickers(text, url) {
  const set = new Set();
  const t = String(text || ""); const lower = t.toLowerCase();
  (t.match(/\$([A-Z]{1,5})\b/g) || []).forEach(s => set.add(s.slice(1)));
  (t.match(/\(([A-Z]{1,5})\)/g) || []).forEach(s => set.add(s.replace(/[()]/g, "")));
  for (const [name, sym] of NAME2TICKER) { if (lower.includes(name)) set.add(sym); }
  if (url) { const m = String(url).match(/\/quote\/([A-Z]{1,5})\b/); if (m) set.add(m[1]); }
  const out = [];
  for (const sym of set) {
    const S = String(sym).toUpperCase().trim();
    if (!/^[A-Z]{1,5}$/.test(S)) continue;
    if (TICKER_BLACKLIST.has(S)) continue;
    out.push(S);
  }
  return out.slice(0, 5);
}

/* ---------------- 1) RSS ---------------- */
async function fetchRss(url, headers = {}) {
  const res = await axios.get(url, { headers, timeout: 45000, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`RSS fetch error ${res.status} for ${url}`);
  return res.data;
}
async function fetchAllFeeds() {
  const UA = { "User-Agent":"Mozilla/5.0", "Accept":"application/rss+xml, text/xml;q=0.9, */*;q=0.8" };
  const urls = [
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "http://rss.cnn.com/rss/money_latest.rss",
    "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=stocks%20(earnings%20OR%20upgrade%20OR%20guidance%20OR%20contract%20OR%20raise)%20site:(yahoo.com%20OR%20cnbc.com%20OR%20cnn.com)"
  ];
  const out=[]; for (const u of urls) { try{ out.push(await fetchRss(u, UA)); } catch(e){ console.error("[warn] RSS:", u, e.message);} await sleep(300); }
  return out;
}

/* ---------------- 2) Parse / group ---------------- */
function parseRssItems(xml) {
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"", textNodeName:"text", cdataPropName:"cdata", trimValues:false });
  let json; try { json = parser.parse(xml); } catch { return []; }
  const items = (json?.rss?.channel?.item) || (json?.feed?.entry) || [];
  const list = Array.isArray(items) ? items : [items];
  const out=[];
  for (const it of list) {
    const title = stripHtml(decode(it?.title?.text ?? it?.title ?? ""));
    let link = decode(it?.link?.href ?? it?.link ?? it?.guid ?? "");
    let desc = stripHtml(decode(it?.description?.text ?? it?.description ?? it?.summary ?? ""));
    if (!link && /href="([^"]+)"/i.test(desc)) link = desc.match(/href="([^"]+)"/i)[1];
    if (!title && !desc) continue;
    const tickers = extractTickers(`${title} ${desc}`, link);
    out.push({ kind:"news", title, url:link, source:(() => { try { return new URL(link).hostname.replace(/^www\./,""); } catch { return ""; } })(), snippet:desc, tickers });
  }
  return out;
}
function groupByTicker(docs) {
  const map=new Map();
  for (const d of docs) for (const t of (d.tickers||[])) {
    if (!/^[A-Z]{1,5}$/.test(t)) continue;
    if (!map.has(t)) map.set(t, []);
    map.get(t).push(d);
  }
  return map;
}

/* ---------- tolerant JSON parsing helpers ---------- */
const stripCodeFences = (s)=>String(s||"").replace(/```(?:json)?\s*([\s\S]*?)\s*```/i,"$1").trim();
function findJsonObjectWithResults(s){
  const txt = String(s||""); const idx = txt.indexOf('"results"'); if (idx === -1) return null;
  let start = txt.lastIndexOf("{", idx); if (start === -1) return null;
  let depth = 0;
  for (let i=start;i<txt.length;i++){
    const ch = txt[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth===0) return txt.slice(start, i+1); }
  }
  return null;
}
function parseProviderJson(s){
  let t = stripCodeFences(s);
  try { return JSON.parse(t); } catch {}
  const chunk = findJsonObjectWithResults(t);
  if (chunk) { try { return JSON.parse(chunk); } catch {} }
  try { return JSON.parse(t.replace(/(['"])?([a-zA-Z0-9_]+)\1\s*:/g,(m,p1,key)=>`"${key}":`).replace(/'/g,'"')); } catch {}
  return null;
}

/* ---------------- 3A) OpenAI (STRICT SCHEMA) ---------------- */
async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) { console.warn("[warn] OPENAI_API_KEY missing"); return { results: [], _err:"missing key" }; }

  const schema = {
    name: "TickerBatch",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["results"],
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ticker", "sentiment", "catalysts"],
            properties: {
              ticker: { type: "string" },
              sentiment: { type: "integer", minimum: 0, maximum: 100 },
              catalysts: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    }
  };

  const body = {
    model: OPENAI_MODEL,
    response_format: { type: "json_schema", json_schema: schema },
    messages: [
      { role:"system", content:"You are an equity options screener. Use ONLY the ticker-scoped headlines/snippets I give you. For EVERY ticker, emit EXACTLY one object. Rate 0–100 for a 3-week call-debit-spread. Catalysts must be specific. Output strict JSON." },
      { role:"user", content: prompt }
    ],
    temperature: 0.2
  };

  const r = await axios.post("https://api.openai.com/v1/chat/completions", body, {
    headers: { Authorization:`Bearer ${OPENAI_API_KEY}` }, timeout: 60000, validateStatus: () => true
  });
  console.log("[openai] status:", r.status);
  if (r.status !== 200) {
    console.error("[openai] error:", r.data?.error?.message || r.statusText);
    return { results: [], _err:`http ${r.status}` };
  }
  const content = r?.data?.choices?.[0]?.message?.content || "{}";
  const json = parseProviderJson(content);
  if (!json) { console.error("[openai] JSON parse failed"); return { results: [], _err:"parse" }; }
  json._ok = true; return json;
}

/* ---------------- 3B) Grok (x.ai) with chat→responses fallback ---------------- */
function parseXaiErrorData(data) {
  const msg = data?.error || data?.message || data?.detail || "";
  if (/credits/i.test(msg)) return { code: "no_credits", msg };
  if (/permission|forbidden/i.test(msg)) return { code: "forbidden", msg };
  return { code: "unknown", msg: msg || "xAI error" };
}

async function callGrok(prompt) {
  if (!XAI_API_KEY) { console.warn("[warn] XAI_API_KEY missing"); return { results: [], _err:"missing key" }; }

  const body = {
    model: XAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are an equity options screener. Use ONLY the text inside PROMPT CORPUS. Return STRICT JSON {results:[{ticker, sentiment, catalysts, rationale, suggested_spread, confidence}]}." },
      { role: "user", content: prompt }
    ],
    temperature: 0.1, top_p: 1, max_tokens: 1200
  };
  let r = await axios.post("https://api.x.ai/v1/chat/completions", body, {
    headers: { Authorization: `Bearer ${XAI_API_KEY}` }, timeout: 60000, validateStatus: () => true
  });
  console.log(`[grok] status: ${r.status} (model=${XAI_MODEL})`);
  if (r.status === 404) {
    const fb = {
      model: XAI_MODEL,
      input: [
        { role: "system", content: "You are an equity options screener. Use ONLY the text inside PROMPT CORPUS. Return STRICT JSON {results:[{ticker, sentiment, catalysts, rationale, suggested_spread, confidence}]}." },
        { role: "user", content: prompt }
      ],
    };
    r = await axios.post("https://api.x.ai/v1/responses", fb, {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` }, timeout: 60000, validateStatus: () => true
    });
    console.log(`[grok:responses] status: ${r.status}`);
  }
  if (r.status !== 200) {
    const err = parseXaiErrorData(r.data);
    console.error("[grok] error:", err.msg);
    return { results: [], _err: err.code, _msg: err.msg };
  }
  const content = r?.data?.choices?.[0]?.message?.content
               || r?.data?.output?.[0]?.content?.[0]?.text
               || "{}";
  const json = parseProviderJson(content);
  if (!json) { console.error("[grok] JSON parse failed"); return { results: [], _err:"parse" }; }
  json._ok = true; return json;
}

/* ---------------- 3C) Groq (OpenAI-compatible) ---------------- */
async function callGroq(prompt) {
  if (!GROQ_API_KEY) { console.warn("[warn] GROQ_API_KEY missing"); return { results: [], _err:"missing key" }; }

  const body = {
    model: GROQ_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role:"system", content:"You are an equity options screener. Use ONLY the text inside PROMPT CORPUS. Return STRICT JSON {results:[{ticker, sentiment, catalysts, rationale}]}. 'sentiment' is 0–100 for 3-week call-debit-spread." },
      { role:"user", content: prompt }
    ],
    temperature: 0.1
  };

  const url = `${GROQ_BASE.replace(/\/+$/,'')}/chat/completions`;
  const r = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    timeout: 60000, validateStatus: () => true
  });
  console.log(`[groq] status: ${r.status} (model=${GROQ_MODEL})`);

  if (r.status !== 200) {
    const msg = r?.data?.error?.message || r?.data?.error || r?.statusText || "groq error";
    console.error("[groq] error:", msg);
    return { results: [], _err:`http ${r.status}`, _msg: msg };
  }

//   const content = r?.data?.choices?.[0]?.message?.content || "{}";
//   console.log("[groq] raw content:", content);
//   const json = parseProviderJson(content);
//   if (!json || !Array.isArray(json?.results)) {
//     console.warn("[groq] fallback triggered: invalid or missing results");
//     return { results: [], _err: "parse" };
// }
  const content = r?.data?.choices?.[0]?.message?.content || "{}";
  // SUGGESTED FIX APPLIED: guard raw payload logs behind env toggle
  //if (LOG_RAW_PAYLOADS) console.log("[groq] raw content (preview):", preview(content));//
  //if (shouldLogGroq()) console.log("[groq] raw content (preview):", preview(content));//
  if (shouldLogGroq()) logGroqRaw(content);

  const json = parseProviderJson(content);
  if (!json || !Array.isArray(json?.results)) {
    console.warn("[groq] fallback triggered: invalid or missing results");
    return { results: [], _err: "parse" };
  }

  if (!json) { console.error("[groq] JSON parse failed"); return { results: [], _err:"parse" }; }
  json._ok = true; return json;
}

/* ---------------- 4) Merge & score ---------------- */
function scoreCatalysts(cats = []) {
  let bonus = 0;
  for (const c of cats) {
    if (/(upgrade|beat|raise|guide|margin|contract|order|backlog|ai|launch|license|win|guidance|eps|rev(?:enue)?)/i.test(c)) bonus += 5;
    if (/(lawsuit|probe|miss|restatement|delist|default|downgrade|dilution)/i.test(c)) bonus -= 8;
  }
  return bonus;
}

function normalizeResults3(baseTickers, gpt, grok, groq) {
  const gptMap  = new Map((gpt?.results  || []).map(r => [String(r.ticker || "").toUpperCase(), r]));
  const grokMap = new Map((grok?.results || []).map(r => [String(r.ticker || "").toUpperCase(), r]));
  const groqMap = new Map((groq?.results || []).map(r => [String(r.ticker || "").toUpperCase(), r]));
  const out = [];
  for (const T of baseTickers) {
    const a = gptMap.get(T)  || {};
    const b = grokMap.get(T) || {};
    const c = groqMap.get(T) || {};
    const sGPT  = Number.isFinite(Number(a.sentiment)) ? Number(a.sentiment) : 50;
    const sGROK = Number.isFinite(Number(b.sentiment)) ? Number(b.sentiment) : 48;
    const sGROQ = Number.isFinite(Number(c.sentiment)) ? Number(c.sentiment) : 48;
    const cats  = uniqueCaseFold([...(a.catalysts || []), ...(b.catalysts || []), ...(c.catalysts || [])]);
    const bonus = 0.1 * scoreCatalysts(cats); // light news-driven bias
    // out.push({
    //   ticker:T,
    //   sentiment_gpt:sGPT,  score_gpt: clamp(sGPT  + bonus, 0, 100),
    //   sentiment_grok:sGROK,score_grok:clamp(sGROK + bonus, 0, 100),
    //   sentiment_groq:sGROQ,score_groq:clamp(sGROQ + bonus, 0, 100),
    //   catalysts: cats
    // });

    out.push({
      ticker: T,
      sentiment_gpt: sGPT,
      score_gpt: clamp(sGPT + bonus, 0, 100),
      catalysts_gpt: a.catalysts || [],
      sentiment_grok: sGROK,
      score_grok: clamp(sGROK + bonus, 0, 100),
      catalysts_grok: b.catalysts || [],
      sentiment_groq: sGROQ,
      score_groq: clamp(sGROQ + bonus, 0, 100),
      catalysts_groq: c.catalysts || [],
      // no merged catalysts!
  });

  }
  return out;
}

/* ---------------- heuristic (news-only) for banners ---------------- */
function newsOnlyScores(byTicker){
  const out=[];
  for (const [t, items] of byTicker.entries()){
    const text = items.map(x => `${x.title} ${x.snippet}`).join(" ").toLowerCase();
    let s = 50;
    if (/\b(beat|upgrade|raise|contract|win|license|record|guidance|ai|chip|backlog)\b/.test(text)) s += 15;
    if (/\b(downgrade|miss|probe|lawsuit|recall|cut|layoff|guidance cut|halt)\b/.test(text)) s -= 15;
    const cats = uniqueCaseFold(items.map(i => i.title).slice(0,6));
    out.push({
      ticker:t,
      sentiment_gpt:s,   score_gpt:s,
      sentiment_grok:s-2,score_grok:s-2,
      sentiment_groq:s-2,score_groq:s-2,
      catalysts:cats
    });
  }
  return out;
}

/* ---------------- 5) Markdown ---------------- */
// function toMarkdown(topGpt, topGrok, topGroq, newsByTicker, banners = [], providerStatus = "") {
// function bulletsFor(t) {
// const raw = (newsByTicker.get(t) || []).map(n => n.title || n.snippet);
// const cats = raw.filter(Boolean).slice(0, 6).map(x => x.replace(/\s*- (CNBC|Yahoo Finance|CNN|Reuters|Bloomberg).*/i, ""));
// return uniqueCaseFold(cats);
// }


// function fmtTickerList(arr) {
// return arr.map(t => t.ticker).join(", ");
// }


// const tickerTable = `
// | Model | Top Tickers |
// |-------|-------------|
// | GPT | ${fmtTickerList(topGpt)} |
// | Groq | ${fmtTickerList(topGroq)} |
// | Grok | ${fmtTickerList(topGrok)} |
// `;


// function fmt(list, key, providerLabel) {
// if (!list.length) return "_No items._";
// return list.map(it => {
// const cats =
// providerLabel === "GPT" ? (it.catalysts_gpt || []) :
// providerLabel === "Grok" ? (it.catalysts_grok || []) :
// (it.catalysts_groq || []);


// const rationale =
// providerLabel === "GPT" ? it.rationale_gpt :
// providerLabel === "Grok" ? it.rationale_grok :
// it.rationale_groq;


// const catTxt = cats.length ? "Catalysts:\n" + cats.map(s => "• " + s).join("\n") : "Catalysts: —";
// const rationaleTxt = rationale ? `\nRationale:\n${rationale}` : "";
// const sent = providerLabel === "GPT" ? it.sentiment_gpt
// : providerLabel === "Grok" ? it.sentiment_grok
// : it.sentiment_groq;
// return `**${it.ticker}** — Score:${it[key]?.toFixed?.(1) ?? "-"} (Sentiment:${sent})\n` + catTxt + rationaleTxt;
// }).join("\n\n");
// }


// const bannerBlock = [providerStatus, ...banners.filter(Boolean)].map(b => b ? `> ${b}` : "").filter(Boolean).join("\n");
// const header = bannerBlock ? bannerBlock + "\n\n" : "";


// return `# Daily Top 10 — Call-Spread Screen (News-driven)


// ${header}${tickerTable}


// ## Top 10 — GPT


// ${fmt(topGpt, "score_gpt", "GPT")}


// ## Top 10 — Groq


// ${fmt(topGroq, "score_groq", "Groq")}


// ## Top 10 — Grok (xAI)


// ${fmt(topGrok, "score_grok", "Grok")}
// `;
// }



// index-v5.js
// Bullet Catalyst (GitHub runner) — OpenAI (GPT) + xAI (Grok) + Groq screen with clear fallbacks.
// Flow: 1) Fetch RSS -> 2) Parse tickers -> 3) GPT + Grok + Groq -> 4) Merge/score -> 5) Markdown -> 6) Email

// ... other code omitted for brevity ...

// function toMarkdown(topGpt, topGrok, topGroq, newsByTicker, banners = [], providerStatus = "") {
//   const MAX_NEWS_BULLETS = 6;
//   const NL = '\n';

//   // Normalize whitespace for email/plaintext
//   function clean(s) {
//     let x = String(s || '');
//     x = x.split('\r\n').join(' ');
//     x = x.split('\n').join(' ');
//     x = x.split('\t').join(' ');
//     x = x.replace(/\s+/g, ' ');
//     return x.trim();
//   }

//   // Grok-like "headline — domain" block, de-duped & capped
//   function newsBulletsWithSource(ticker, n = MAX_NEWS_BULLETS) {
//     const items = newsByTicker.get(ticker) || [];
//     const seen = new Set();
//     const out = [];
//     for (const it of items) {
//       const title = clean((it && (it.title || it.snippet)) || '');
//       if (!title) continue;
//       const key = title.toLowerCase();
//       if (seen.has(key)) continue;
//       seen.add(key);

//       let domain = clean((it && it.source) || '');
//       if (!domain && it && it.url) {
//         try {
//           const host = new URL(it.url).hostname;
//           domain = host && host.startsWith('www.') ? host.slice(4) : host;
//         } catch {}
//       }
//       out.push(`• ${title}${domain ? ' - ' + domain : ''}`);
//       if (out.length >= n) break;
//     }
//     return out;
//   }

//   function fmtTickerList(arr) { return arr.map(t => t.ticker).join(', '); }

//   const tickerTable = [
//     '| Model | Top Tickers |',
//     '|-------|-------------|',
//     `| GPT   | ${fmtTickerList(topGpt)} |`,
//     `| Groq  | ${fmtTickerList(topGroq)} |`,
//     `| Grok  | ${fmtTickerList(topGrok)} |`,
//     ''
//   ].join(NL);

//   function fmt(list, key, providerLabel) {
//     if (!list.length) return '_No items._';
//     return list.map(it => {
//       const sent = providerLabel === 'GPT'  ? it.sentiment_gpt
//                  : providerLabel === 'Grok' ? it.sentiment_grok
//                  :                            it.sentiment_groq;

//       // Provider-specific catalysts to keep style closer to Grok
//       const cats = providerLabel === 'GPT'  ? (it.catalysts_gpt  || [])
//                  : providerLabel === 'Grok' ? (it.catalysts_grok || [])
//                  :                            (it.catalysts_groq || []);

//       const catLines = cats.slice(0, MAX_NEWS_BULLETS).map(s => `• ${clean(s)}`);
//       const newsLines = newsBulletsWithSource(it.ticker);

//       const blocks = [];
//       if (catLines.length) blocks.push('Catalysts:' + NL + catLines.join(NL));
//       if (newsLines.length) blocks.push('Top headlines:' + NL + newsLines.join(NL));

//       const scoreVal = it[key];
//       const score = (scoreVal && typeof scoreVal.toFixed === 'function')
//         ? scoreVal.toFixed(1)
//         : (Number.isFinite(scoreVal) ? String(scoreVal) : '-');

//       return `**${it.ticker}** — Score:${score} (Sentiment:${sent})` + NL + blocks.join(NL + NL);
//     }).join(NL + NL);
//   }

//   const bannerBlock = [providerStatus, ...banners.filter(Boolean)]
//     .map(b => b ? `> ${b}` : '')
//     .filter(Boolean)
//     .join(NL);
//   const header = bannerBlock ? bannerBlock + NL + NL : '';

//   return [
//     '# Daily Top 10 — Call-Spread Screen (News-driven)',
//     '',
//     header + tickerTable,
//     '## Top 10 — GPT',
//     '',
//     fmt(topGpt, 'score_gpt', 'GPT'),
//     '',
//     '## Top 10 — Groq',
//     '',
//     fmt(topGroq, 'score_groq', 'Groq'),
//     '',
//     '## Top 10 — Grok (xAI)',
//     '',
//     fmt(topGrok, 'score_grok', 'Grok'),
//     ''
//   ].join(NL);
// }


function toMarkdown(topGpt, topGrok, topGroq, newsByTicker, banners = [], providerStatus = "") {
  const MAX_NEWS_BULLETS = 6;
  const NL = '\n';
  const HR1 = '#'.repeat(70);
  const HR2 = '#'.repeat(49);
  const HR3 = '#'.repeat(28);

  // Keep bullets tidy in email/plaintext
  function clean(s) {
    let x = String(s || '');
    x = x.split('\r\n').join(' ');
    x = x.split('\n').join(' ');
    x = x.split('\t').join(' ');
    x = x.replace(/\s+/g, ' ');
    return x.trim();
  }

  // Grok-like headlines: "• headline - domain", deduped & capped
  function newsBulletsWithSource(ticker, n = MAX_NEWS_BULLETS) {
    const items = newsByTicker.get(ticker) || [];
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const title = clean((it && (it.title || it.snippet)) || '');
      if (!title) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let domain = clean((it && it.source) || '');
      if (!domain && it && it.url) {
        try {
          const host = new URL(it.url).hostname;
          domain = host && host.startsWith('www.') ? host.slice(4) : host;
        } catch {}
      }

      out.push('• ' + title + (domain ? ' - ' + domain : ''));
      if (out.length >= n) break;
    }
    return out;
  }

  function fmtTickerList(arr) { return arr.map(t => t.ticker).join(', '); }

  const tickerTable = [
    '| Model | Top Tickers |',
    '|-------|-------------|',
    '| GPT   | ' + fmtTickerList(topGpt) + ' |',
    '| Groq  | ' + fmtTickerList(topGroq) + ' |',
    '| Grok  | ' + fmtTickerList(topGrok) + ' |',
    ''
  ].join(NL);

  function fmt(list, key, providerLabel) {
    if (!list.length) return '_No items._';
    return list.map(it => {
      const sent = providerLabel === 'GPT'  ? it.sentiment_gpt
                 : providerLabel === 'Grok' ? it.sentiment_grok
                 :                            it.sentiment_groq;

      // Keep provider-specific catalysts (closer to Grok style)
      const cats = providerLabel === 'GPT'  ? (it.catalysts_gpt  || [])
                 : providerLabel === 'Grok' ? (it.catalysts_grok || [])
                 :                            (it.catalysts_groq || []);

      const catLines  = cats.slice(0, MAX_NEWS_BULLETS).map(s => '• ' + clean(s));
      const newsLines = newsBulletsWithSource(it.ticker);

      const blocks = [];
      if (catLines.length) blocks.push('Catalysts:' + NL + catLines.join(NL));
      if (newsLines.length) blocks.push('Top headlines:' + NL + newsLines.join(NL));

      const scoreVal = it[key];
      const score = (scoreVal && typeof scoreVal.toFixed === 'function')
        ? scoreVal.toFixed(1)
        : (Number.isFinite(scoreVal) ? String(scoreVal) : '-');

      return '**' + it.ticker + '** — Score:' + score + ' (Sentiment:' + sent + ')' + NL + blocks.join(NL + NL);
    }).join(NL + NL);
  }

  const bannerBlock = [providerStatus, ...banners.filter(Boolean)]
    .map(b => b ? '> ' + b : '')
    .filter(Boolean)
    .join(NL);
  const header = bannerBlock ? bannerBlock + NL + NL : '';

  return [
    '# Daily Top 10 — Call-Spread Screen (News-driven)',
    '',
    header + tickerTable,
    HR1, HR2, HR3,
    '## Top 10 — GPT',
    HR3, HR2, HR1,
    '',
    fmt(topGpt, 'score_gpt', 'GPT'),
    '',
    HR1, HR2, HR3,
    '## Top 10 — Groq',
    HR3, HR2, HR1,
    '',
    fmt(topGroq, 'score_groq', 'Groq'),
    '',
    HR1, HR2, HR3,
    '## Top 10 — Grok (xAI)',
    HR3, HR2, HR1,
    '',
    fmt(topGrok, 'score_grok', 'Grok'),
    ''
  ].join(NL);
}


/* ---------------- 6) Email ---------------- */
async function sendEmail(subject, markdown) {
  const missing=[]; for (const k of ["SMTP_HOST","SMTP_PORT","SMTP_USER","SMTP_PASS","EMAIL_FROM","EMAIL_TO"]) { if (!envTrim(k)) missing.push(k); }
  if (missing.length) { console.log("[info] email disabled (missing env):", missing.join(", ")); console.log("----- MARKDOWN -----\n"+markdown); return; }
  const port = Number(SMTP_PORT_RAW || "465");
  const secure = port === 465;
  console.log(`[smtp] connecting ${SMTP_HOST}:${port} secure=${secure}`);
  const transporter = nodemailer.createTransport({ host: SMTP_HOST, port, secure, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  await transporter.verify();
  await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, text: markdown });
  console.log("[ok] email sent");
}

/* ---------------- helper: provider status summary ---------------- */
function providerStatusSummary(gpt, grok, groq) {
  function stat(p, label){
    if (Array.isArray(p?.results) && p.results.length > 0) return `${label}: OK (${p.results.length})`;
    if (p?._err === "missing key") return `${label}: NO_KEY`;
    if (p?._err) return `${label}: ${String(p._err).toUpperCase()}`;
    return `${label}: EMPTY`;
  }
  return `${stat(gpt,"GPT")} | ${stat(grok,"Grok")} | ${stat(groq,"Groq")}`;
}

/* ---------------- main ---------------- */
async function main() {
  console.log("[run] fetching RSS…");
  const xmls = await fetchAllFeeds();
  const docs = xmls.flatMap(parseRssItems);
  const byTicker = groupByTicker(docs);
  const baseTickers = [...byTicker.keys()];
  if (!baseTickers.length) { console.log("[warn] no tickers discovered — exiting."); return; }

  const corpus = baseTickers.map(t => {
    const news = byTicker.get(t) || [];
    const text = news.map(n => `• ${n.title}${n.title && n.snippet ? " — " : ""}${n.snippet}`).join("\n");
    return `=== ${t} ===\n${text || "(no news)"}\n`;
  }).join("\n").slice(0, 16000);

  const openaiPrompt = `PROMPT CORPUS:\n${corpus}\n\nTASK:\nFor EVERY ticker in the CORPUS, output one object with {ticker, sentiment (0–100), catalysts[]}.`;
  const xaiPrompt    = `PROMPT CORPUS:\n${corpus}\n\nTASK:\nDiscover tickers and return TOP 10 objects {ticker, sentiment, catalysts, rationale, suggested_spread, confidence}.`;
  const groqPrompt   = `PROMPT CORPUS:\n${corpus}\n\nTASK:\nFor EVERY ticker, return STRICT JSON {results:[{ticker, sentiment, catalysts, rationale}]}. 'sentiment' is 0–100 for a 3-week call-debit-spread.`;

  console.log("[run] calling OpenAI…");
  const gpt  = await (DRY_RUN ? { results: [], _err:"dry" } : callOpenAI(openaiPrompt));

  console.log("[run] calling Grok (xAI)…");
  const grok = await (DRY_RUN ? { results: [], _err:"dry" } : callGrok(xaiPrompt));

  console.log("[run] calling Groq…");
  const groq = await (DRY_RUN ? { results: [], _err:"dry" } : callGroq(groqPrompt));

  console.log(`[debug] gpt  results: ${gpt.results?.length  ?? 0} (err=${gpt._err  ?? "none"})`);
  console.log(`[debug] grok results: ${grok.results?.length ?? 0} (err=${grok._err ?? "none"})`);
  console.log(`[debug] groq results: ${groq.results?.length ?? 0} (err=${groq._err ?? "none"})`);

  if (!DRY_RUN && (!Array.isArray(gpt.results) || gpt.results.length === 0)
               && (!Array.isArray(grok.results) || grok.results.length === 0)
               && (!Array.isArray(groq.results) || groq.results.length === 0)) {
    throw new Error("All providers returned no results. Check API keys, quotas, or model names.");
  }

  let banners = [];
  const newsHeur = new Map(newsOnlyScores(byTicker).map(x=>[x.ticker,x]));

  // Fill in missing providers with heuristics (if enabled)
  let gptFill  = gpt;
  let grokFill = grok;
  let groqFill = groq;

  if ((!Array.isArray(gpt.results)  || gpt.results.length  === 0) && HEURISTIC_FALLBACK) {
    banners.push("**OpenAI returned no structured results; GPT section uses news-only heuristics.**");
    gptFill = { results: baseTickers.map(t => newsHeur.get(t)).filter(Boolean) };
  }
  if ((!Array.isArray(grok.results) || grok.results.length === 0) && HEURISTIC_FALLBACK) {
    const reason = grok._err === "no_credits"
      ? "Grok unavailable (xAI team has no credits)"
      : (grok._msg ? `Grok unavailable (${grok._msg})` : "Grok unavailable");
    banners.push(`**${reason}; Grok section uses news-only heuristics.**`);
    grokFill = { results: baseTickers.map(t => newsHeur.get(t)).filter(Boolean) };
  }
  if ((!Array.isArray(groq.results) || groq.results.length === 0) && HEURISTIC_FALLBACK) {
    const reason = groq._msg ? `Groq unavailable (${groq._msg})` : "Groq unavailable";
    banners.push(`**${reason}; Groq section uses news-only heuristics.**`);
    groqFill = { results: baseTickers.map(t => newsHeur.get(t)).filter(Boolean) };
  }

  console.log("[merge] Results passed into normalizeResults3:");
  console.log("- GPT  length:", gptFill.results?.length);
  console.log("- Grok length:", grokFill.results?.length);
  console.log("- Groq length:", groqFill.results?.length);

  
  const combined = normalizeResults3(baseTickers, gptFill, grokFill, groqFill);

  const topGpt   = pick([...combined].sort((a,b) => b.score_gpt  - a.score_gpt ), 10);
  const topGrok  = pick([...combined].sort((a,b) => b.score_grok - a.score_grok), 10);
  const topGroq  = pick([...combined].sort((a,b) => b.score_groq - a.score_groq), 10);

  const providerStatus = providerStatusSummary(gpt, grok, groq);
  const md = toMarkdown(topGpt, topGrok, topGroq, byTicker, banners, providerStatus);

  // add provider status to subject for quick visibility
  await sendEmail(`Top 10 Call-Spread Candidates — GPT, Grok & Groq (last ~3w) [${providerStatus}]`, md);
}

main().catch(e => { console.error(e); process.exit(1); });
