// Bullet Catalyst (GitHub runner) — mirrors your n8n flow
// 1) Fetch RSS (CNBC/CNN/Google) -> 2) Parse tickers -> 3) Prompt OpenAI & xAI (Grok)
// 4) Merge & score -> 5) Markdown -> 6) Email (Gmail SMTP)

import axios from "axios";
import nodemailer from "nodemailer";
import { XMLParser } from "fast-xml-parser";
import he from "he";

const {
  OPENAI_API_KEY,
  XAI_API_KEY,
  EMAIL_FROM,
  EMAIL_TO,        // comma-separated ok
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  OPENAI_MODEL = "gpt-4o-mini",
  XAI_MODEL = "grok-4-fast-reasoning",
} = process.env;

const DRY_RUN = process.argv.includes("--dry-run");

// ---------------- Helpers ----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stripHtml = (s) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const decode = (s) => he.decode(String(s || ""));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function pick(arr, n) { return arr.slice(0, n); }

function uniqueCaseFold(arr) {
  const seen = new Set(); const out = [];
  for (const v of arr) {
    const k = String(v).toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(v);
  }
  return out;
}

function extractTickersFreeform(text) {
  // $NVDA / (NVDA) / AAPL before stock keywords
  const set = new Set();
  (text.match(/\$([A-Z]{1,5})\b/g) || []).forEach(s => set.add(s.slice(1)));
  (text.match(/\(([A-Z]{1,5})\)/g) || []).forEach(s => set.add(s.replace(/[()]/g, "")));
  (text.match(/\b([A-Z]{1,5})\b(?=\s+(?:stock|shares|results|earnings|guidance|upgrade|downgrade))/gi) || [])
    .forEach(s => set.add(s.toUpperCase()));
  return [...set].filter(t => /^[A-Z]{1,5}$/.test(t)).slice(0, 5);
}

// ---------------- 1) Fetch RSS ----------------
async function fetchRss(url, headers = {}) {
  const res = await axios.get(url, { headers, timeout: 45000, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`RSS fetch error ${res.status} for ${url}`);
  return res.data;
}

async function fetchAllFeeds() {
  const UA = { "User-Agent": "Mozilla/5.0", "Accept": "application/rss+xml, text/xml;q=0.9, */*;q=0.8" };
  const urls = [
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "http://rss.cnn.com/rss/money_latest.rss",
    "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=stocks%20(earnings%20OR%20upgrade%20OR%20guidance%20OR%20contract%20OR%20raise)%20site:(yahoo.com%20OR%20cnbc.com%20OR%20cnn.com)"
  ];
  const out = [];
  for (const u of urls) {
    try { out.push(await fetchRss(u, UA)); } catch (e) { console.error("[warn] RSS:", u, e.message); }
    await sleep(300);
  }
  return out;
}

// ---------------- 2) Parse tickers & group ----------------
function parseRssItems(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "text",
    cdataPropName: "cdata",
    trimValues: false
  });
  let json;
  try { json = parser.parse(xml); } catch { return []; }

  const items =
    (json?.rss?.channel?.item) ||
    (json?.feed?.entry) ||
    [];

  const list = Array.isArray(items) ? items : [items];
  const out = [];

  for (const it of list) {
    const title = stripHtml(decode(it?.title?.text ?? it?.title ?? ""));
    let link = decode(it?.link?.href ?? it?.link ?? it?.guid ?? "");
    let desc = stripHtml(decode(it?.description?.text ?? it?.description ?? it?.summary ?? ""));
    if (!link && /href="([^"]+)"/i.test(desc)) link = desc.match(/href="([^"]+)"/i)[1];

    if (!title && !desc) continue;

    const text = `${title} ${desc}`;
    const tickers = extractTickersFreeform(text);
    out.push({
      kind: "news",
      title,
      url: link,
      source: (() => { try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return ""; } })(),
      snippet: desc,
      tickers
    });
  }
  return out;
}

function groupByTicker(docs) {
  const map = new Map();
  for (const d of docs) {
    for (const t of (d.tickers || [])) {
      if (!/^[A-Z]{1,5}$/.test(t)) continue;
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(d);
    }
  }
  return map;
}

function prepTickerText(t, docs) {
  const lines = docs.map(n => `• ${n.title}${n.title && n.snippet ? " — " : ""}${n.snippet}`).join("\n");
  const newsText = (lines || "(no news)").slice(0, 8000);
  return { ticker: t, newsText };
}

// ---------------- 3) Call LLMs (OpenAI + Grok) ----------------
async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) return { results: [] };
  const body = {
    model: OPENAI_MODEL,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "TickerBatch",
        strict: true,
        schema: {
          type: "object",
          required: ["results"],
          additionalProperties: false,
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                required: ["ticker", "sentiment", "catalysts"],
                additionalProperties: true,
                properties: {
                  ticker: { type: "string" },
                  sentiment: { type: "integer", minimum: 0, maximum: 100 },
                  catalysts: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        }
      }
    },
    messages: [
      {
        role: "system",
        content:
          "You are an equity options screener. Use ONLY the ticker-scoped headlines/snippets I give you. " +
          "For EVERY ticker, emit EXACTLY one object. Rate 0–100 for a 3-week call-debit-spread. " +
          "Catalysts must be specific with numbers/counterparties/events. Output strict JSON."
      },
      { role: "user", content: prompt }
    ],
    temperature: 0.2
  };
  const r = await axios.post("https://api.openai.com/v1/chat/completions", body, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    timeout: 60000,
    validateStatus: () => true
  });
  const content = r?.data?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(content); } catch { return { results: [] }; }
}

async function callGrok(prompt) {
  if (!XAI_API_KEY) return { results: [] };
  const body = {
    model: XAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are an equity options screener. Use ONLY the text inside PROMPT CORPUS. " +
          "Return STRICT JSON {results:[{ticker, sentiment, catalysts, rationale, suggested_spread, confidence}]}. " +
          "sentiment 0–100; confidence 0–100."
      },
      { role: "user", content: prompt }
    ],
    temperature: 0.1,
    top_p: 1,
    max_tokens: 1200
  };
  const r = await axios.post("https://api.x.ai/v1/chat/completions", body, {
    headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    timeout: 60000,
    validateStatus: () => true
  });
  const content = r?.data?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(content); } catch { return { results: [] }; }
}

// ---------------- 4) Merge & Score ----------------
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
    const sGPT = Number.isFinite(Number(a.sentiment)) ? Number(a.sentiment) : 50;
    const sGROK = Number.isFinite(Number(b.sentiment)) ? Number(b.sentiment) : 50;
    const cats = uniqueCaseFold([...(a.catalysts || []), ...(b.catalysts || [])]);
    const bonus = 0.1 * scoreCatalysts(cats);
    out.push({
      ticker: T,
      sentiment_gpt: sGPT,
      sentiment_grok: sGROK,
      score_gpt: clamp(sGPT + bonus, 0, 100),
      score_grok: clamp(sGROK + bonus, 0, 100),
      catalysts: cats
    });
  }
  return out;
}

// ---------------- 5) Markdown ----------------
function toMarkdown(topGpt, topGrok, newsByTicker) {
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
  return (
`# Daily Top 10 — Call-Spread Screen (News-driven)

## Top 10 — GPT

${fmt(topGpt, "score_gpt")}

## Top 10 — Grok

${fmt(topGrok, "score_grok")}
`);
}

// ---------------- 6) Email ----------------
async function sendEmail(subject, markdown) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM || !EMAIL_TO) {
    console.log("[info] email disabled (missing SMTP/EMAIL env).");
    console.log("----- MARKDOWN -----\n" + markdown);
    return;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    secure: Number(SMTP_PORT || 465) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text: markdown
  });
  console.log("[ok] email sent");
}

// ---------------- Main ----------------
async function main() {
  console.log("[run] fetching RSS…");
  const xmls = await fetchAllFeeds();
  const docs = xmls.flatMap(parseRssItems);

  const byTicker = groupByTicker(docs);
  const baseTickers = [...byTicker.keys()];
  if (!baseTickers.length) {
    console.log("[warn] no tickers discovered — exiting.");
    return;
  }

  // Build a single prompt corpus (like n8n Pre-stringify)
  const corpus = baseTickers.map(t => {
    const news = byTicker.get(t) || [];
    const text = news.map(n => `• ${n.title}${n.title && n.snippet ? " — " : ""}${n.snippet}`).join("\n");
    return `=== ${t} ===\n${text || "(no news)"}\n`;
  }).join("\n").slice(0, 16000);

  const openaiPrompt =
    `PROMPT CORPUS:\n${corpus}\n\n` +
    "TASK:\n" +
    "For EVERY ticker in the CORPUS, output one object with {ticker, sentiment (0–100), catalysts[]}.";

  const grokPrompt =
    `PROMPT CORPUS:\n${corpus}\n\n` +
    "TASK:\n" +
    "Discover tickers and return TOP 10 objects {ticker, sentiment, catalysts, rationale, suggested_spread, confidence}.";

  console.log("[run] calling OpenAI…");
  const gpt = await (DRY_RUN ? { results: [] } : callOpenAI(openaiPrompt));
  console.log("[run] calling Grok…");
  const grok = await (DRY_RUN ? { results: [] } : callGrok(grokPrompt));

  // Normalize/score
  const combined = normalizeResults(baseTickers, gpt, grok);
  const topGpt = pick([...combined].sort((a,b) => b.score_gpt - a.score_gpt), 10);
  const topGrok = pick([...combined].sort((a,b) => b.score_grok - a.score_grok), 10);

  const md = toMarkdown(topGpt, topGrok, byTicker);

  const subject = `Top 10 Call-Spread Candidates — GPT & Grok (last ~3w)`;
  await sendEmail(subject, md);
}

main().catch(e => { console.error(e); process.exit(1); });
