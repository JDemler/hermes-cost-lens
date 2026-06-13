/* Hermes Cost Lens — analyze agent session JSONs, price them via OpenRouter,
   and visualize per-call / per-message cost as flamegraph + treemap. */

"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  sessions: [],        // { name, raw, analysis }
  activeIdx: -1,
  openrouter: null,    // model id -> pricing object
  openrouterStatus: "loading",
  fallbackPricing: null,
  fallbackStatus: "loading",
  priceSource: {},      // model id -> { source, matchedId }
  prices: {},          // model id -> { in, out, cacheRead } in $/token
};

const COLORS = { cached: "#38bdf8", fresh: "#fbbf24", output: "#f472b6" };

const $ = (sel) => document.querySelector(sel);

function syncHermesTheme() {
  let source;
  try {
    source = window.parent && window.parent !== window
      ? window.parent.getComputedStyle(window.parent.document.documentElement)
      : null;
  } catch {
    source = null;
  }
  if (!source) return;

  const root = document.documentElement;
  const map = {
    "--bg": ["--color-background"],
    "--bg2": ["--color-card", "--color-popover"],
    "--bg3": ["--color-muted", "--color-accent"],
    "--border": ["--color-border"],
    "--fg": ["--color-foreground", "--color-card-foreground"],
    "--muted": ["--color-muted-foreground"],
    "--accent": ["--color-primary", "--color-ring"],
    "--accent-fg": ["--color-primary-foreground"],
    "--green": ["--color-chart-2", "--color-primary"],
    "--radius": ["--radius"],
  };

  for (const [target, candidates] of Object.entries(map)) {
    const value = candidates.map((name) => source.getPropertyValue(name).trim()).find(Boolean);
    if (value) root.style.setProperty(target, value);
  }

  const parentBody = window.parent.getComputedStyle(window.parent.document.body);
  const font = source.getPropertyValue("--font-sans").trim() || parentBody.fontFamily;
  if (font) root.style.setProperty("--font", font);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtMoney(v) {
  if (v == null || isNaN(v)) return "—";
  if (v === 0) return "$0";
  if (v < 0.0001) return "$" + v.toExponential(2);
  if (v < 0.01) return "$" + v.toFixed(5);
  if (v < 1) return "$" + v.toFixed(4);
  return "$" + v.toFixed(2);
}

function fmtTok(v) {
  if (v == null || isNaN(v)) return "—";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e4) return (v / 1e3).toFixed(1) + "k";
  if (v >= 1e3) return (v / 1e3).toFixed(2) + "k";
  return Math.round(v).toLocaleString();
}

function fmtPct(v) {
  return (v * 100).toFixed(v >= 0.1 ? 1 : 2) + "%";
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------------------
// Session analysis (model-independent: token estimates + call structure)
// ---------------------------------------------------------------------------

const estTok = (chars) => Math.ceil(chars / 4); // ~4 chars/token heuristic

function toolCallChars(toolCalls) {
  if (!toolCalls || !toolCalls.length) return 0;
  return toolCalls.reduce((sum, tc) => {
    const fn = tc.function || {};
    return sum + (fn.name || "").length + (fn.arguments || "").length + 30; // 30 ≈ structural overhead
  }, 0);
}

function analyzeSession(raw) {
  const items = [];
  const sysPrompt = raw.system_prompt || "";
  items.push({
    id: 0, role: "system", toolName: null, label: "System prompt",
    ctxEst: estTok(sysPrompt.length), outEst: 0, msg: { content: sysPrompt },
  });

  for (const m of raw.messages || []) {
    if (m.role === "session_meta") continue;
    if (m.active === 0) continue;
    const content = m.content || "";
    const tcChars = toolCallChars(m.tool_calls);
    const ctxChars = content.length + tcChars;
    let outEst = 0;
    if (m.role === "assistant") {
      outEst = estTok(content.length + (m.reasoning || "").length + tcChars);
    }
    let label;
    if (m.role === "tool") label = `Tool result: ${m.tool_name || "?"}`;
    else if (m.role === "assistant") {
      const tcNames = (m.tool_calls || []).map((tc) => tc.function?.name).filter(Boolean);
      label = tcNames.length ? `Assistant → ${tcNames.join(", ")}` : "Assistant reply";
    } else label = `${m.role[0].toUpperCase()}${m.role.slice(1)} message`;

    items.push({
      id: items.length, role: m.role, toolName: m.tool_name || null, label,
      ctxEst: estTok(ctxChars), outEst, msg: m,
    });
  }

  // One API call per assistant message. Context = everything before it.
  // Everything sent in a previous request is assumed cache-hit (validated
  // against the session's reported cache_read_tokens later).
  const calls = [];
  let boundary = 0; // first item index never sent as input before
  for (let k = 0; k < items.length; k++) {
    if (items[k].role !== "assistant") continue;
    calls.push({
      n: calls.length + 1,
      asstId: k,
      cachedIds: items.slice(0, boundary).map((it) => it.id),
      freshIds: items.slice(boundary, k).map((it) => it.id),
    });
    boundary = k;
  }

  return { items, calls };
}

// ---------------------------------------------------------------------------
// Cost computation (depends on prices, re-run on every price edit)
// ---------------------------------------------------------------------------

function computeCosts(session, prices) {
  const { items, calls } = session.analysis;
  const raw = session.raw;

  const cacheRead = raw.cache_read_tokens || 0;
  const inputTok = raw.input_tokens;
  const outputTok = raw.output_tokens;
  const cachingOn = cacheRead > 0;

  // Effective per-call pools (if the provider reported no cache reads,
  // every context token was billed as fresh input).
  const effCalls = calls.map((c) => ({
    ...c,
    cachedIds: cachingOn ? c.cachedIds : [],
    freshIds: cachingOn ? c.freshIds : [...c.cachedIds, ...c.freshIds],
  }));

  const sumEst = (ids) => ids.reduce((s, id) => s + items[id].ctxEst, 0);
  let sumCachedEst = 0, sumFreshEst = 0, sumOutEst = 0;
  for (const c of effCalls) {
    sumCachedEst += sumEst(c.cachedIds);
    sumFreshEst += sumEst(c.freshIds);
    sumOutEst += items[c.asstId].outEst;
  }

  // Scale char-based estimates so pools match the session's reported totals.
  const freshTarget = inputTok != null ? inputTok : null;
  const fCached = cachingOn && sumCachedEst > 0 ? cacheRead / sumCachedEst : 1;
  const fFresh = freshTarget != null && sumFreshEst > 0 ? freshTarget / sumFreshEst : 1;
  const fOut = outputTok != null && sumOutEst > 0 ? outputTok / sumOutEst : 1;
  // single "size" factor used when displaying a message's token count
  const ctxTotal = (inputTok != null ? inputTok : sumFreshEst) + cacheRead;
  const fSize = sumCachedEst + sumFreshEst > 0 ? ctxTotal / (sumCachedEst + sumFreshEst) : 1;

  const perItem = items.map((it) => ({
    item: it, sentCount: 0,
    cachedTok: 0, freshTok: 0, outTok: 0,
    contextCost: 0, outputCost: 0, totalCost: 0,
    sizeTok: it.ctxEst * fSize,
  }));

  const costCalls = effCalls.map((c) => {
    const mk = (ids, f, price, bucket) => ids.map((id) => {
      const tok = items[id].ctxEst * f;
      const cost = tok * price;
      const agg = perItem[id];
      agg.sentCount++;
      agg[bucket] += tok;
      agg.contextCost += cost;
      return { id, tok, cost };
    });
    const cachedParts = mk(c.cachedIds, fCached, prices.cacheRead, "cachedTok");
    const freshParts = mk(c.freshIds, fFresh, prices.in, "freshTok");
    const outTokScaled = items[c.asstId].outEst * fOut;
    const outCost = outTokScaled * prices.out;
    const agg = perItem[c.asstId];
    agg.outTok += outTokScaled;
    agg.outputCost += outCost;

    const cachedTok = d3.sum(cachedParts, (p) => p.tok);
    const freshTok = d3.sum(freshParts, (p) => p.tok);
    const cachedCost = d3.sum(cachedParts, (p) => p.cost);
    const freshCost = d3.sum(freshParts, (p) => p.cost);
    return {
      n: c.n, asstId: c.asstId, cachedParts, freshParts,
      cachedTok, freshTok, outTok: outTokScaled,
      cachedCost, freshCost, outCost,
      totalCost: cachedCost + freshCost + outCost,
    };
  });

  for (const p of perItem) p.totalCost = p.contextCost + p.outputCost;

  const totals = {
    cost: d3.sum(costCalls, (c) => c.totalCost),
    cachedTok: d3.sum(costCalls, (c) => c.cachedTok),
    freshTok: d3.sum(costCalls, (c) => c.freshTok),
    outTok: d3.sum(costCalls, (c) => c.outTok),
    cachedCost: d3.sum(costCalls, (c) => c.cachedCost),
    freshCost: d3.sum(costCalls, (c) => c.freshCost),
    outCost: d3.sum(costCalls, (c) => c.outCost),
    cachingOn,
  };

  return { calls: costCalls, perItem, totals };
}

// ---------------------------------------------------------------------------
// Pricing (OpenRouter)
// ---------------------------------------------------------------------------

async function fetchOpenRouterPricing() {
  await Promise.all([fetchBundledPricing(), fetchLiveOpenRouterPricing()]);
  if (state.activeIdx >= 0) refreshPricesForActive(true);
}

async function fetchLiveOpenRouterPricing() {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.openrouter = new Map(data.data.map((m) => [m.id, m.pricing]));
    state.openrouterStatus = "ok";
  } catch (e) {
    console.warn("OpenRouter pricing fetch failed:", e);
    state.openrouterStatus = "error";
  }
}

async function fetchBundledPricing() {
  try {
    const res = await fetch("openrouter-prices.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.fallbackPricing = {
      models: new Map((data.models || []).map((m) => [m.id, m.pricing])),
      aliases: data.aliases || {},
      generatedAt: data.generated_at,
    };
    state.fallbackStatus = "ok";
  } catch (e) {
    console.warn("Bundled pricing load failed:", e);
    state.fallbackStatus = "error";
  }
}

function normalizeModelId(modelId) {
  return String(modelId || "").trim().toLowerCase();
}

function findPricing(map, modelId, aliases = {}) {
  if (!map || !modelId) return null;
  const wanted = normalizeModelId(modelId);
  const alias = aliases[wanted];
  if (alias && map.has(alias)) return { id: alias, pricing: map.get(alias) };
  if (map.has(wanted)) return { id: wanted, pricing: map.get(wanted) };

  const suffixMatches = [...map.keys()].filter((id) => id.split("/").pop() === wanted);
  if (suffixMatches.length === 1) return { id: suffixMatches[0], pricing: map.get(suffixMatches[0]) };

  const bare = wanted.replace(/^.*\//, "");
  const exactBare = [...map.keys()].find((id) => id.split("/").pop() === bare);
  if (exactBare) return { id: exactBare, pricing: map.get(exactBare) };

  return null;
}

function parsePricing(p) {
  const f = (v) => (v != null ? parseFloat(v) : 0);
  return { in: f(p.prompt), out: f(p.completion), cacheRead: f(p.input_cache_read) };
}

function defaultPricesFor(modelId) {
  const live = findPricing(state.openrouter, modelId);
  if (live) return { prices: parsePricing(live.pricing), source: "live", matchedId: live.id };

  const fallback = findPricing(
    state.fallbackPricing?.models,
    modelId,
    state.fallbackPricing?.aliases,
  );
  if (fallback) return { prices: parsePricing(fallback.pricing), source: "bundled", matchedId: fallback.id };

  return null;
}

function refreshPricesForActive(overwriteFromApi) {
  const s = state.sessions[state.activeIdx];
  if (!s) return;
  const model = s.raw.model || "unknown";
  if (!state.prices[model] || overwriteFromApi) {
    const def = defaultPricesFor(model);
    if (def) {
      state.prices[model] = def.prices;
      state.priceSource[model] = { source: def.source, matchedId: def.matchedId };
    } else if (!state.prices[model]) {
      state.prices[model] = { in: 0, out: 0, cacheRead: 0 };
      state.priceSource[model] = { source: "manual", matchedId: null };
    }
  }
  renderPricingInputs();
  renderAll();
}

function activePrices() {
  const s = state.sessions[state.activeIdx];
  const model = s?.raw.model || "unknown";
  return state.prices[model] || { in: 0, out: 0, cacheRead: 0 };
}

function renderPricingInputs() {
  const s = state.sessions[state.activeIdx];
  if (!s) return;
  const model = s.raw.model || "unknown";
  $("#pricing-model").textContent = "— " + model;
  const p = activePrices();
  const perM = (v) => +(v * 1e6).toPrecision(6);
  $("#price-input").value = perM(p.in);
  $("#price-output").value = perM(p.out);
  $("#price-cache-read").value = perM(p.cacheRead);

  const pill = $("#pricing-status");
  if (state.openrouterStatus === "loading") { pill.textContent = "fetching OpenRouter prices…"; pill.className = "pill"; }
  else {
    const src = state.priceSource[model];
    if (src?.source === "live") {
      pill.textContent = src.matchedId === model ? "live from OpenRouter" : `live from OpenRouter (${src.matchedId})`;
      pill.className = "pill ok";
    } else if (src?.source === "bundled") {
      pill.textContent = `bundled fallback (${src.matchedId})`;
      pill.className = "pill ok";
    } else if (state.openrouterStatus === "error" && state.fallbackStatus === "error") {
      pill.textContent = "pricing unavailable — enter prices manually";
      pill.className = "pill err";
    } else {
      pill.textContent = "model not in pricing tables — enter prices manually";
      pill.className = "pill err";
    }
  }
}

function bindPricingInputs() {
  const map = { "price-input": "in", "price-output": "out", "price-cache-read": "cacheRead" };
  for (const [id, key] of Object.entries(map)) {
    document.getElementById(id).addEventListener("input", (e) => {
      const s = state.sessions[state.activeIdx];
      if (!s) return;
      const model = s.raw.model || "unknown";
      state.prices[model] = { ...activePrices(), [key]: (parseFloat(e.target.value) || 0) / 1e6 };
      state.priceSource[model] = { source: "manual", matchedId: null };
      renderAll();
    });
  }
}

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

function normalizeHermesSession(raw, fallbackName) {
  const meta = raw.session || raw.metadata || raw;
  const messages = raw.messages || raw.history || raw.conversation || [];
  if (!Array.isArray(messages)) throw new Error("no messages[] array");

  return {
    ...meta,
    ...raw,
    messages,
    title: raw.title || meta.title || fallbackName,
    model: raw.model || meta.model || "unknown",
    input_tokens: raw.input_tokens ?? raw.prompt_tokens ?? meta.input_tokens ?? meta.prompt_tokens,
    output_tokens: raw.output_tokens ?? raw.completion_tokens ?? meta.output_tokens ?? meta.completion_tokens,
    cache_read_tokens: raw.cache_read_tokens ?? meta.cache_read_tokens ?? 0,
    estimated_cost_usd: raw.estimated_cost_usd ?? raw.cost_usd ?? meta.estimated_cost_usd ?? meta.cost_usd,
  };
}

function addSession(name, raw) {
  const normalized = normalizeHermesSession(raw, name);
  const session = { name, raw: normalized, analysis: analyzeSession(normalized) };
  state.sessions.push(session);
  state.activeIdx = state.sessions.length - 1;
  $("#app").hidden = false;
  $("#clear-sessions").hidden = false;
  $("#dropzone").classList.add("compact");
  $("#dropzone").querySelector("p").innerHTML = "Drop session JSON files here to compare against this session.";
  renderTabs();
  refreshPricesForActive(false);
}

function loadFiles(fileList) {
  for (const file of fileList) {
    file.text().then((text) => {
      try {
        const raw = JSON.parse(text);
        addSession(file.name, raw);
      } catch (e) {
        alert(`Could not parse ${file.name}: ${e.message}`);
      }
    });
  }
}

function hermesFetchJSON(path) {
  const parentSDK = window.parent?.__HERMES_PLUGIN_SDK__;
  if (parentSDK?.fetchJSON) return parentSDK.fetchJSON(path);
  return fetch(path, { credentials: "same-origin" }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

function setAutoloadStatus(message, kind = "") {
  const el = $("#autoload-status");
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    el.className = "autoload-status";
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = `autoload-status ${kind}`.trim();
}

async function fetchHermesSession(sessionId) {
  try {
    return await hermesFetchJSON(`/api/sessions/${encodeURIComponent(sessionId)}/export`);
  } catch (exportErr) {
    const [meta, messagesResp] = await Promise.all([
      hermesFetchJSON(`/api/sessions/${encodeURIComponent(sessionId)}`),
      hermesFetchJSON(`/api/sessions/${encodeURIComponent(sessionId)}/messages`),
    ]);
    const messages = messagesResp.messages || messagesResp.items || messagesResp;
    if (!Array.isArray(messages)) throw exportErr;
    return { ...meta, messages };
  }
}

async function loadSessionFromQuery() {
  const sessionId = new URLSearchParams(window.location.search).get("session");
  if (!sessionId) return;

  setAutoloadStatus(`Loading Hermes session ${sessionId}...`);
  try {
    const raw = await fetchHermesSession(sessionId);
    addSession(raw.title || sessionId, raw);
    setAutoloadStatus(`Loaded Hermes session ${raw.title || sessionId}.`, "ok");
  } catch (e) {
    console.error("Hermes session load failed:", e);
    setAutoloadStatus(`Could not load Hermes session ${sessionId}: ${e.message}`, "err");
  }
}

function bindFileInputs() {
  $("#file-input").addEventListener("change", (e) => { loadFiles(e.target.files); e.target.value = ""; });
  $("#clear-sessions").addEventListener("click", () => {
    state.sessions = [];
    state.activeIdx = -1;
    $("#app").hidden = true;
    $("#clear-sessions").hidden = true;
    $("#detail").hidden = true;
    $("#dropzone").classList.remove("compact");
    $("#dropzone").querySelector("p").innerHTML = "Open a session from the Hermes dashboard, or use <strong>Load session JSON</strong> as a fallback.";
    setAutoloadStatus("");
  });
  const dz = $("#dropzone");
  for (const target of [dz, document.body]) {
    target.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
    target.addEventListener("dragleave", () => dz.classList.remove("drag"));
    target.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files);
    });
  }
}

function renderTabs() {
  const nav = $("#session-tabs");
  nav.innerHTML = "";
  state.sessions.forEach((s, i) => {
    const b = document.createElement("button");
    b.textContent = s.raw.title || s.name;
    b.className = i === state.activeIdx ? "active" : "";
    b.onclick = () => { state.activeIdx = i; renderTabs(); refreshPricesForActive(false); };
    nav.appendChild(b);
  });
  nav.style.display = state.sessions.length > 1 ? "flex" : "none";
}

// ---------------------------------------------------------------------------
// Tooltip + detail drawer
// ---------------------------------------------------------------------------

const tooltip = {
  el: null,
  show(html, ev) {
    this.el.innerHTML = html;
    this.el.hidden = false;
    this.move(ev);
  },
  move(ev) {
    const pad = 14;
    const r = this.el.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    this.el.style.left = x + "px";
    this.el.style.top = y + "px";
  },
  hide() { this.el.hidden = true; },
};

function ttRows(rows) {
  return rows.map(([k, v]) => `<div class="r"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
}

function showItemDetail(agg, totals) {
  const it = agg.item;
  $("#detail-title").textContent = `#${it.id} — ${it.label}`;
  const m = it.msg;
  const kv = [
    ["Role", it.role + (it.toolName ? ` (${it.toolName})` : "")],
    ["Size (est. tokens)", fmtTok(agg.sizeTok)],
    ["Times in context", agg.sentCount + "×"],
    ["…as cached tokens", fmtTok(agg.cachedTok)],
    ["…as fresh tokens", fmtTok(agg.freshTok)],
    ["Output tokens", fmtTok(agg.outTok)],
    ["Context cost", fmtMoney(agg.contextCost)],
    ["Output cost", fmtMoney(agg.outputCost)],
    ["Total cost", fmtMoney(agg.totalCost) + ` (${fmtPct(agg.totalCost / totals.cost)} of session)`],
  ];
  let body = `<div class="kv">${kv.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join("")}</div>`;
  const cut = (s, n = 12000) => (s.length > n ? s.slice(0, n) + `\n… [${(s.length - n).toLocaleString()} more chars]` : s);
  if (m.reasoning) body += `<h4>Reasoning</h4><pre>${esc(cut(m.reasoning))}</pre>`;
  if (m.tool_calls?.length) {
    const tc = m.tool_calls.map((t) => ({ name: t.function?.name, arguments: t.function?.arguments }));
    body += `<h4>Tool calls</h4><pre>${esc(cut(JSON.stringify(tc, null, 2)))}</pre>`;
  }
  if (m.content) body += `<h4>Content</h4><pre>${esc(cut(m.content))}</pre>`;
  $("#detail-body").innerHTML = body;
  $("#detail").hidden = false;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  const s = state.sessions[state.activeIdx];
  if (!s) return;
  const costs = computeCosts(s, activePrices());
  s.costs = costs;
  renderSummary(s, costs);
  renderFlamegraph(s, costs);
  renderTreemap(s, costs);
  renderTable(s, costs);
  renderInsights(s, costs);
}

function renderSummary(s, { totals, calls }) {
  const raw = s.raw;
  const dur = raw.started_at && raw.ended_at ? `${Math.round(raw.ended_at - raw.started_at)}s` : null;
  const noCacheCost = totals.cachedTok * (activePrices().in - activePrices().cacheRead);
  const cards = [
    ["Total cost", fmtMoney(totals.cost), raw.estimated_cost_usd != null ? `session reports ${fmtMoney(raw.estimated_cost_usd)}` : "", "money"],
    ["API calls", calls.length, `avg ${fmtMoney(totals.cost / Math.max(calls.length, 1))} / call`, ""],
    ["Fresh input", fmtTok(totals.freshTok), fmtMoney(totals.freshCost), "fresh"],
    ["Cached input", fmtTok(totals.cachedTok), totals.cachingOn ? `${fmtMoney(totals.cachedCost)} · saved ~${fmtMoney(noCacheCost)} vs uncached` : "no cache hits", "cached"],
    ["Output", fmtTok(totals.outTok), fmtMoney(totals.outCost), "output"],
    ["Model", raw.model || "?", [raw.source, dur].filter(Boolean).join(" · "), ""],
  ];
  $("#summary-cards").innerHTML = cards.map(([k, v, sub, cls]) =>
    `<div class="card"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(String(v))}</div><div class="s">${esc(sub)}</div></div>`
  ).join("");
}

// --- Flamegraph (3-row icicle: calls / pools / messages) -------------------

function renderFlamegraph(s, costs) {
  const container = $("#flamegraph");
  container.innerHTML = "";
  const W = container.clientWidth || 1000;
  const rowH = 44, gap = 2, labelH = 16;
  const H = rowH * 3 + gap * 2 + labelH;
  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("height", H);

  const total = costs.totals.cost;
  if (!(total > 0)) {
    container.innerHTML = `<p class="hint">Total cost is $0 — set prices above to see the breakdown.</p>`;
    return;
  }
  const x = d3.scaleLinear([0, total], [0, W]);
  const items = s.analysis.items;
  const perItem = costs.perItem;

  const shade = (base, i) => {
    const c = d3.color(base);
    return (i % 2 ? c.darker(0.55) : c).toString();
  };

  const addRect = (x0, x1, y, h, fill, ttHtml, onClick, label, labelFill = "#0d1117") => {
    const w = Math.max(x(x1) - x(x0) - 0.5, 0.5);
    const r = svg.append("rect")
      .attr("x", x(x0)).attr("y", y).attr("width", w).attr("height", h)
      .attr("fill", fill).attr("rx", 2);
    r.on("mousemove", (ev) => tooltip.show(ttHtml, ev))
      .on("mouseleave", () => tooltip.hide());
    if (onClick) r.on("click", onClick);
    if (label && w > 46) {
      svg.append("text")
        .attr("x", x(x0) + w / 2).attr("y", y + h / 2 + 4)
        .attr("text-anchor", "middle").attr("fill", labelFill)
        .attr("font-size", 11).attr("font-weight", 600)
        .text(label.length * 6.6 > w ? label.slice(0, Math.floor(w / 6.6) - 1) + "…" : label);
    }
    return r;
  };

  let cx = 0;
  for (const call of costs.calls) {
    const c0 = cx, c1 = cx + call.totalCost;
    const asst = items[call.asstId];

    // Row 1: the API call
    addRect(c0, c1, labelH, rowH, "#3b4453",
      `<div class="t">API call #${call.n}</div>` + ttRows([
        ["cached input", `${fmtTok(call.cachedTok)} · ${fmtMoney(call.cachedCost)}`],
        ["fresh input", `${fmtTok(call.freshTok)} · ${fmtMoney(call.freshCost)}`],
        ["output", `${fmtTok(call.outTok)} · ${fmtMoney(call.outCost)}`],
        ["total", fmtMoney(call.totalCost)],
        ["result", asst.label],
      ]),
      () => showItemDetail(perItem[call.asstId], costs.totals),
      `#${call.n} ${fmtMoney(call.totalCost)}`, "#e6edf3");

    // Row 2: pools + Row 3: per-message blocks
    let px = c0;
    const pools = [
      ["cached input", call.cachedCost, COLORS.cached, call.cachedParts, call.cachedTok],
      ["fresh input", call.freshCost, COLORS.fresh, call.freshParts, call.freshTok],
      ["output", call.outCost, COLORS.output, null, call.outTok],
    ];
    for (const [name, cost, color, parts, tok] of pools) {
      if (!(cost > 0)) continue;
      addRect(px, px + cost, labelH + rowH + gap, rowH, color,
        `<div class="t">Call #${call.n} — ${name}</div>` + ttRows([
          ["tokens", fmtTok(tok)], ["cost", fmtMoney(cost)],
          ["share of call", fmtPct(cost / call.totalCost)],
        ]),
        null, `${name} ${fmtMoney(cost)}`);

      const y3 = labelH + (rowH + gap) * 2;
      if (parts) {
        let mx = px;
        parts.forEach((p, i) => {
          if (!(p.cost > 0)) return;
          const it = items[p.id];
          addRect(mx, mx + p.cost, y3, rowH, shade(color, i),
            `<div class="t">#${it.id} ${esc(it.label)}</div>` + ttRows([
              ["tokens here", fmtTok(p.tok)], ["cost here", fmtMoney(p.cost)],
              ["pool", name],
              ["total over session", fmtMoney(perItem[p.id].totalCost)],
            ]),
            () => showItemDetail(perItem[p.id], costs.totals),
            it.toolName || it.role);
          mx += p.cost;
        });
      } else {
        addRect(px, px + cost, y3, rowH, shade(color, 0),
          `<div class="t">#${asst.id} ${esc(asst.label)} (generation)</div>` + ttRows([
            ["output tokens", fmtTok(tok)], ["cost", fmtMoney(cost)],
          ]),
          () => showItemDetail(perItem[call.asstId], costs.totals),
          "gen");
      }
      px += cost;
    }
    cx = c1;
  }

  svg.append("text").attr("x", 0).attr("y", 11).attr("fill", "#8b949e").attr("font-size", 11)
    .text(`session total ${fmtMoney(total)} → ${W}px`);

  container.appendChild(svg.node());
}

// --- Treemap (cumulative attribution per message) ---------------------------

function categoryOf(it) {
  if (it.role === "system") return "System prompt";
  if (it.role === "user") return "User messages";
  if (it.role === "tool") return `Tool: ${it.toolName || "?"}`;
  return "Assistant";
}

function renderTreemap(s, costs) {
  const container = $("#treemap");
  container.innerHTML = "";
  const W = container.clientWidth || 1000;
  const H = 420;

  const leaves = costs.perItem.filter((p) => p.totalCost > 0);
  if (!leaves.length) { container.innerHTML = `<p class="hint">Nothing to show yet.</p>`; return; }

  const byCat = d3.group(leaves, (p) => categoryOf(p.item));
  const rootData = {
    name: "session",
    children: [...byCat, ].map(([cat, members]) => ({ name: cat, children: members })),
  };
  const root = d3.hierarchy(rootData)
    .sum((d) => d.totalCost || 0)
    .sort((a, b) => b.value - a.value);
  d3.treemap().size([W, H]).paddingInner(2).paddingTop(20).paddingOuter(3).round(true)(root);

  const cats = [...byCat.keys()];
  const color = d3.scaleOrdinal(cats, d3.schemeTableau10.concat(d3.schemeSet3));

  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("height", H);

  // category headers
  for (const cat of root.children || []) {
    svg.append("rect")
      .attr("x", cat.x0).attr("y", cat.y0)
      .attr("width", cat.x1 - cat.x0).attr("height", cat.y1 - cat.y0)
      .attr("fill", "none").attr("stroke", "#2d333b").attr("rx", 4);
    if (cat.x1 - cat.x0 > 60) {
      svg.append("text")
        .attr("x", cat.x0 + 5).attr("y", cat.y0 + 14)
        .attr("fill", "#8b949e").attr("font-size", 11).attr("font-weight", 600)
        .text(`${cat.data.name} · ${fmtMoney(cat.value)}`);
    }
  }

  for (const leaf of root.leaves()) {
    const p = leaf.data;
    const it = p.item;
    const w = leaf.x1 - leaf.x0, h = leaf.y1 - leaf.y0;
    if (w <= 0 || h <= 0) continue;
    const cat = categoryOf(it);
    svg.append("rect")
      .attr("x", leaf.x0).attr("y", leaf.y0).attr("width", w).attr("height", h)
      .attr("fill", color(cat)).attr("fill-opacity", 0.82).attr("rx", 3)
      .on("mousemove", (ev) => tooltip.show(
        `<div class="t">#${it.id} ${esc(it.label)}</div>` + ttRows([
          ["size", fmtTok(p.sizeTok) + " tok"],
          ["times in context", p.sentCount + "×"],
          ["context cost", fmtMoney(p.contextCost)],
          ["output cost", fmtMoney(p.outputCost)],
          ["total", `${fmtMoney(p.totalCost)} (${fmtPct(p.totalCost / costs.totals.cost)})`],
        ]), ev))
      .on("mouseleave", () => tooltip.hide())
      .on("click", () => showItemDetail(p, costs.totals));
    if (w > 56 && h > 30) {
      svg.append("text")
        .attr("x", leaf.x0 + 5).attr("y", leaf.y0 + 14)
        .attr("fill", "#0d1117").attr("font-size", 11).attr("font-weight", 650)
        .text(`#${it.id} ${it.toolName || it.role}`.slice(0, Math.floor(w / 6.5)));
      svg.append("text")
        .attr("x", leaf.x0 + 5).attr("y", leaf.y0 + 27)
        .attr("fill", "#0d1117").attr("font-size", 10.5)
        .text(fmtMoney(p.totalCost));
    }
  }

  container.appendChild(svg.node());
}

// --- Table -------------------------------------------------------------------

let tableSort = { k: "totalCost", dir: -1 };

function renderTable(s, costs) {
  const tbody = $("#msg-table tbody");
  const total = costs.totals.cost || 1;
  const rows = costs.perItem.map((p) => ({
    idx: p.item.id,
    label: p.item.label,
    role: p.item.role,
    tokens: p.sizeTok,
    sentCount: p.sentCount,
    contextCost: p.contextCost,
    outputCost: p.outputCost,
    totalCost: p.totalCost,
    pct: p.totalCost / total,
    agg: p,
  }));
  rows.sort((a, b) => {
    const va = a[tableSort.k], vb = b[tableSort.k];
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * tableSort.dir;
  });
  const maxCost = d3.max(rows, (r) => r.totalCost) || 1;

  tbody.innerHTML = rows.map((r) => `
    <tr data-idx="${r.idx}">
      <td class="num">${r.idx}</td>
      <td><span class="role-badge role-${esc(r.role)}">${esc(r.role)}</span>${esc(r.label)}</td>
      <td class="num">${fmtTok(r.tokens)}</td>
      <td class="num">${r.sentCount}×</td>
      <td class="num">${fmtMoney(r.contextCost)}</td>
      <td class="num">${fmtMoney(r.outputCost)}</td>
      <td class="num bar-cell"><div class="mini-bar" style="width:${(r.totalCost / maxCost * 100).toFixed(1)}%"></div><span>${fmtMoney(r.totalCost)}</span></td>
      <td class="num">${fmtPct(r.pct)}</td>
    </tr>`).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.onclick = () => {
      const p = costs.perItem[+tr.dataset.idx];
      showItemDetail(p, costs.totals);
    };
  });
}

function bindTableSort() {
  document.querySelectorAll("#msg-table th").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (tableSort.k === k) tableSort.dir *= -1;
      else tableSort = { k, dir: -1 };
      const s = state.sessions[state.activeIdx];
      if (s?.costs) renderTable(s, s.costs);
    });
  });
}

// --- Insights ----------------------------------------------------------------

function renderInsights(s, costs) {
  const { perItem, totals, calls } = costs;
  const p = activePrices();
  const out = [];
  const money = (v) => `<span class="money">${fmtMoney(v)}</span>`;

  const sorted = [...perItem].sort((a, b) => b.totalCost - a.totalCost);
  const top = sorted[0];
  if (top && top.totalCost > 0) {
    const share = top.totalCost / totals.cost;
    let advice = "";
    if (top.item.role === "tool") advice = `Truncate or summarize this tool's output before it enters the context — it was re-sent ${top.sentCount}×.`;
    else if (top.item.role === "system") advice = `It is re-sent with every one of the ${calls.length} API calls — every token you cut from it saves ${calls.length}× its price.`;
    else if (top.item.role === "assistant") advice = `Most of this is generation cost — consider limiting reasoning effort or response length.`;
    out.push(`Biggest single cost driver: <strong>#${top.item.id} ${esc(top.item.label)}</strong> at ${money(top.totalCost)} (${fmtPct(share)} of the session). ${advice}`);
  }

  // tool aggregate
  const byTool = d3.rollup(perItem.filter((x) => x.item.role === "tool"),
    (v) => d3.sum(v, (x) => x.totalCost), (x) => x.item.toolName || "?");
  const topTool = [...byTool].sort((a, b) => b[1] - a[1])[0];
  if (topTool && topTool[1] > 0) {
    out.push(`Most expensive tool: <strong>${esc(topTool[0])}</strong> — its results cost ${money(topTool[1])} (${fmtPct(topTool[1] / totals.cost)}) in re-sent context.`);
  }

  const sys = perItem[0];
  if (sys && sys.totalCost > 0) {
    out.push(`The system prompt (${fmtTok(sys.sizeTok)} tokens) costs ${money(sys.totalCost)} (${fmtPct(sys.totalCost / totals.cost)}) because it rides along in all ${calls.length} calls.`);
  }

  if (totals.cachingOn) {
    const saved = totals.cachedTok * (p.in - p.cacheRead);
    out.push(`Prompt caching saved you ~${money(saved)}: ${fmtTok(totals.cachedTok)} tokens were billed at the cache-read rate (${(p.cacheRead * 1e6).toFixed(3)} $/M) instead of the input rate (${(p.in * 1e6).toFixed(3)} $/M).`);
  } else if (totals.freshTok > 0 && p.cacheRead > 0 && p.cacheRead < p.in) {
    const potential = (totals.freshTok - totals.freshTok / Math.max(calls.length, 1)) * (p.in - p.cacheRead);
    out.push(`No cache hits were reported. With prompt caching you could save up to ~${money(potential)} on the repeated context.`);
  }

  if (calls.length > 3) {
    const last = calls[calls.length - 1], first = calls[0];
    const growth = (last.cachedCost + last.freshCost) / Math.max(first.cachedCost + first.freshCost, 1e-9);
    if (growth > 2) {
      out.push(`Context cost per call grew ${growth.toFixed(1)}× from the first to the last call. For long sessions, consider compacting/summarizing history or splitting work into sub-sessions.`);
    }
  }

  $("#insights").innerHTML = out.map((t) => `<li>${t}</li>`).join("");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  syncHermesTheme();
  tooltip.el = $("#tooltip");
  bindFileInputs();
  bindPricingInputs();
  bindTableSort();
  $("#detail-close").onclick = () => { $("#detail").hidden = true; };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#detail").hidden = true; });
  let rT;
  window.addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(renderAll, 150); });
  window.setInterval(syncHermesTheme, 2000);
  fetchOpenRouterPricing();
  loadSessionFromQuery();
});
