// Bullet Catalyst — GitHub runner
// 1) RSS -> 2) Parse tickers -> 3) OpenAI + xAI -> 4) Merge/score -> 5) Markdown -> 6) Email
// Robust JSON schema, tolerant parsing, Grok model fallback.

import axios from "axios";
import nodemailer from "nodemailer";
import { XMLParser } from "fast-xml-parser";
import he from "he";

/* --------------------- ENV --------------------- */
const envTrim = (n, d = "") => (typeof process.env[n] === "string" ? process.env[n].trim() : d);
const mask = (s) => (!s ? "MISSING" : s.length <= 8 ? "****" : s.slice(0, 3) + "…" + s.slice(-4));

const OPENAI_API_KEY = envTrim("OPENAI_API_KEY");
const XAI_API_KEY    = envTrim("XAI_API_KEY");
const EMAIL_FROM     = envTrim("EMAIL_FROM");
const EMAIL_TO       = envTrim("EMAIL_TO");
const SMTP_HOST      = envTrim("SMTP_HOST");
const SMTP_PORT_RAW  = envTrim("SMTP_PORT");
const SMTP_USER      = envTrim("SMTP_USER");
const SMTP_PASS      = envTrim("SMTP_PASS");
const OPENAI_MODEL   = envTrim("OPENAI_MODEL", "gpt-4o-mini");
const XAI_MODEL      = envTrim("XAI_MODEL", "grok-2-latest");
const DRY_RUN        = process.argv.includes("--dry-run");

console.log("[env] OPENAI_API_KEY:", mask(OPENAI_API_KEY));
console.log("[env] XAI_API_KEY   :", mask(XAI_API_KEY));

/* ------------------- Helpers ------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stripHtml = (s) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const decode = (s) => he.decode(String(s || ""));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pick = (arr, n) => arr.slice(0, n);
function uniqueCaseFold(arr){const seen=new Set();const out=[];for(const v of arr){const k=String(v).toLowerCase().trim();if(!k||seen.has(k))continue;seen.add(k);out.push(v);}return out;}
const safeHost = (u)=>{ try{ return new URL(u).hostname.replace(/^www\./,""); } catch { return ""; } };

/* ---------- Name → ticker map + blacklist ---------- */
const NAME2TICKER = Object.entries({
  'nvidia':'NVDA','intel':'INTC','apple':'AAPL','microsoft':'MSFT',
  'advanced micro devices':'AMD','amd':'AMD','tesla':'TSLA','amazon':'AMZN',
  'alphabet':'GOOGL','google':'GOOGL','meta':'META','facebook':'META',
  'broadcom':'AVGO','taiwan semiconductor':'TSM','tsmc':'TSM','netflix':'NFLX',
  'oracle':'ORCL','salesforce':'CRM','ibm':'IBM','walmart':'WMT','nike':'NKE',
  'ferrari':'RACE','dell':'DELL','workday':'WDAY','crowdstrike':'CRWD',
  'toast':'TOST','alibaba':'BABA','baidu':'BIDU','texas instruments':'TXN',
  'micron':'MU','palantir':'PLTR','jpmorgan':'JPM'
});
const TICKER_BLACKLIST = new Set([
  "IN","WITH","AND","THE","FOR","FROM","OVER","AFTER","BEFORE","FIRST",
  "SECOND","THIRD","NEWS","CNBC","CNN","TECH","STOCK","MARKET","EARNINGS",
  "RESULTS","SHARES","OFF","S","INTEL"
]);

function extractTickers(text, url) {
  const set = new Set(); const t = String(text || ""); const lower = t.toLowerCase();
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

/* -------------------- RSS -------------------- */
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
  const out=[];
  for (const u of urls) {
    try { out.push(await fetchRss(u, UA)); }
    catch(e){ console.error("[warn] RSS:", u, e.message); }
    await sleep(250);
  }
  return out;
}

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
    out.push({ title, url:link, source: safeHost(link), snippet:desc, tickers });
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

/* ------------- tolerant JSON parsing ------------- */
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

/* ---------------- OpenAI ---------------- */
async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) { console.warn("[warn] OPENAI_API_KEY missing"); return { results: [], _err:"missing key" }; }

  // Valid JSON schema for OpenAI strict mode
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
            additionalProperties: false,   // <— the key fix
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
    headers: { Authorization:`Bearer ${OPENAI_API_KEY}` },
    timeout: 60000, validateStatus: () => true
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

/* ---------------- Grok (x.ai) with fallback ---------------- */
const XAI_MODEL_CANDIDATES = (m0) => uniqueCaseFold([m0, "grok-2-latest", "grok-2", "grok-2-mini"]);

async function callGrokOnce(model, prompt) {
  const body = {
    model,
    // Comment out response_format if your account/model rejects it
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are an equity options screener. Use ONLY the text inside PROMPT CORPUS. Return STRICT JSON {results:[{ticker, sentiment, catalysts, rationale, suggested_spread, confidence}]}." },
      { role: "user", content: prompt }
    ],
    temperature: 0.1, top_p: 1, max_tokens: 1200
  };
  const r = await axios.post("https://api.x.ai/v1/chat/completions", body, {
    headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    timeout: 60000, validateStatus: () => true
  });
  console.log(`[grok] status: ${r.status} (model=${model})`);
  if (r.status !== 200) {
    return { ok:false, status:r.status, msg:r.data?.error?.message || r.statusText };
  }
  const content = r?.data?.choices?.[0]?.message?.content || "{}";
  const json = parseProviderJson(content);
  if (!json) return { ok:false, status:200, msg:"parse" };
  json._ok = true; return { ok:true, json };
}

async function callGrok(prompt) {
  if (!XAI_API_KEY) { console.warn("[warn] XAI_API_KEY missing"); return { results: [], _err:"missing key" }; }
  for (const m of XAI_MODEL_CANDIDATES(XAI_MODEL)) {
    const res = await callGrokOnce(m, prompt);
    if (res.ok) return res.json;
    console.error("[grok] error:", res.msg);
    // 403/404/400 → try next candidate
    if (![400,403,404].includes(res.status)) break;
    await sleep(300);
  }
  return { results: [], _err:"unavailable" };
}

/* --------------- Merge & score --------------- */
function scoreCatalysts(cats = []) {
  let bonus = 0;
  for (const c of cats) {
    if (/(upgrade|beat|raise|guide|margin|contract|order|backlog|ai|launch|license|win|guidance|eps|rev(?:enue)?)/i.test(c)) bonus += 5;
    if (/(lawsuit|probe|miss|restatement|delist|default|downgrade|dilution)/i.test(c)) bonus -= 8;
  }
  return bonus;
}
function normalizeResults(baseTickers, gpt, grok) {
  const gptMap = new Map((gpt.results || []).map(r => [String(r.ticker || "").toUpperCase(), r]));
  const grokMap = new Map((grok.results || []).map(r => [String(r.ticker || "").toUpperCase(), r]));
  const out = [];
  for (const T of baseTickers) {
    const a = gptMap.get(T) || {};
    const b = grokMap.get(T) || {};
    const sGPT  = Number.isFinite(Number(a.sentiment)) ? Number(a.sentiment) : 50;
    const sGROK = Number.isFinite(Number(b.sentiment)) ? Number(b.sentiment) : 50;
    const cats  = uniqueCaseFold([...(a.catalysts || []), ...(b.catalysts || [])]);
    const bonus = 0.1 * scoreCatalysts(cats);
    out.push({ ticker:T, sentiment_gpt:sGPT, sentiment_grok:sGROK,
               score_gpt:clamp(sGPT + bonus, 0, 100), score_grok:clamp(sGROK + bonus, 0, 100),
               catalysts: cats });
  }
  return out;
}

/* --------- Heuristic fallback (news only) --------- */
function newsOnlyScores(byTicker){
  const out=[];
  for (const [t, items] of byTicker.entries()){
    const text = items.map(x => `${x.title} ${x.snippet}`).join(" ").toLowerCase();
    let s = 50;
    if (/\b(beat|upgrade|raise|contract|win|license|record|guidance|ai|chip|backlog)\b/.test(text)) s += 15;
    if (/\b(downgrade|miss|probe|lawsuit|recall|cut|layoff|guidance cut|halt)\b/.test(text)) s -= 15;
    const cats = uniqueCaseFold(items.map(i => i.title).slice(0,6));
    out.push({ ticker:t, sentiment_gpt:s, sentiment_grok:s-2, score_gpt:s, score_grok:s-2, catalysts:cats });
  }
  return out;
}

/* ---------------- Markdown ---------------- */
function toMarkdown(topGpt, topGrok, newsByTicker, note="") {
  function bulletsFor(t) {
    const raw = (newsByTicker.get(t) || []).map(n => n.title || n.snippet);
    const cats = raw.filter(Boolean).slice(0, 6).map(x => x.replace(/\s*- (CNBC|Yahoo Finance|CNN|Reuters|Bloomberg).*/i, ""));
    return uniqueCaseFold(cats);
  }
  function fmt(list, key) {
    if (!list.length) return "_No items._";
    return list.map(it => {
      const cats = it.catalysts.length ? it.catalysts : bulletsFor(it.ticker);
      const catTxt = cats.length ? "Catalysts:\n" + cats.map(s => "• " + s).join("\n") : "Catalysts: —";
      return `**${it.ticker}** — Score:${it[key]?.toFixed?.(1) ?? "-"}\n` +
             `Sentiment(GPT):${it.sentiment_gpt} | Sentiment(Grok):${it.sentiment_grok}\n` +
             catTxt;
    }).join("\n\n");
  }
  return `# Daily Top 10 — Call-Spread Screen (News-driven)
${note ? `\n> ${note}\n` : ""}

## Top 10 — GPT

${fmt(topGpt, "score_gpt")}

## Top 10 — Grok

${fmt(topGrok, "score_grok")}
`;
}

/* ---------------- Email ---------------- */
async function sendEmail(subject, markdown) {
  const missing=[]; for (const k of ["SMTP_HOST","SMTP_PORT","SMTP_USER","SMTP_PASS","EMAIL_FROM","EMAIL_TO"]) { if (!envTrim(k)) missing.push(k); }
  if (missing.length) {
    console.log("[info] email disabled (missing env):", missing.join(", "));
    console.log("----- MARKDOWN -----\n"+markdown);
    return;
  }
  const port = Number(SMTP_PORT_RAW || "465");
  const secure = port === 465; // 465 SSL, 587 STARTTLS
  console.log(`[smtp] connecting ${SMTP_HOST}:${port} secure=${secure}`);
  const transporter = nodemailer.createTransport({ host: SMTP_HOST, port, secure, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  await transporter.verify();
  await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, text: markdown });
  console.log("[ok] email sent");
}

/* ---------------- Main ---------------- */
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
  const grokPrompt   = `PROMPT CORPUS:\n${corpus}\n\nTASK:\nDiscover tickers and return TOP 10 objects {ticker, sentiment, catalysts, rationale, suggested_spread, confidence}.`;

  console.log("[run] calling OpenAI…");
  const gpt  = await (DRY_RUN ? { results: [], _err:"dry" } : callOpenAI(openaiPrompt));
  console.log("[run] calling Grok…");
  const grok = await (DRY_RUN ? { results: [], _err:"dry" } : callGrok(grokPrompt));

  console.log(`[debug] gpt results: ${gpt.results?.length ?? 0} (err=${gpt._err ?? "none"})`);
  console.log(`[debug] grok results: ${grok.results?.length ?? 0} (err=${grok._err ?? "none"})`);

  let combined;
  let note = "";

  if (!DRY_RUN && (!Array.isArray(gpt.results) || gpt.results.length === 0) && (!Array.isArray(grok.results) || grok.results.length === 0)) {
    throw new Error("Both providers returned no results. Check API keys, quotas, or model names (see status logs).");
  } else if (!Array.isArray(gpt.results) || gpt.results.length === 0) {
    note = "OpenAI returned no structured results; using Grok + news heuristics.";
    const grokOnly = normalizeResults(baseTickers, {results:[]}, grok);
    const newsHeur = new Map(newsOnlyScores(byTicker).map(x=>[x.ticker,x]));
    for (const r of grokOnly){ const h=newsHeur.get(r.ticker); if (h) { r.score_gpt=h.score_gpt; r.sentiment_gpt=h.sentiment_gpt; } }
    combined = grokOnly;
  } else if (!Array.isArray(grok.results) || grok.results.length === 0) {
    note = "Grok unavailable; using OpenAI + news heuristics.";
    const gptOnly = normalizeResults(baseTickers, gpt, {results:[]});
    const newsHeur = new Map(newsOnlyScores(byTicker).map(x=>[x.ticker,x]));
    for (const r of gptOnly){ const h=newsHeur.get(r.ticker); if (h) { r.score_grok=h.score_grok; r.sentiment_grok=h.sentiment_grok; } }
    combined = gptOnly;
  } else {
    combined = normalizeResults(baseTickers, gpt, grok);
  }

  const topGpt   = pick([...combined].sort((a,b) => b.score_gpt  - a.score_gpt ), 10);
  const topGrok  = pick([...combined].sort((a,b) => b.score_grok - a.score_grok), 10);

  const md = toMarkdown(topGpt, topGrok, byTicker, note);
  await sendEmail(`Top 10 Call-Spread Candidates — GPT & Grok (last ~3w)`, md);
}
main().catch(e => { console.error(e); process.exit(1); });
