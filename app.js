(function () {
  "use strict";


  const OFFLINE_MODE = true;
  const OFFLINE_SESSION_KEY = "trendTrainerOfflineSessions";
  const OFFLINE_OPENAI_KEY = "trendTrainerOpenAIKey";
  const offlineCache = { manifest: null, symbols: new Map() };
  const offlineCoachProfiles = {
    quick: {
      label: "快速指導",
      model: "gpt-5.4-mini",
      candleLimit: 140,
      maxOutputTokens: 1200,
      focus: "請用短句給即時修正。只抓最重要的趨勢方向、趨勢型態、K線型態、關鍵價位、一個最大風險，以及下一根到三根K線要觀察什麼。",
    },
    standard: {
      label: "標準指導",
      model: "gpt-5.4",
      candleLimit: 240,
      maxOutputTokens: 2200,
      focus: "請做完整盤勢拆解，包含趨勢結構、趨勢型態、K線型態、支撐壓力、量價、使用者區間標記、交易計劃風險與下一步觀察。",
    },
    deep: {
      label: "深度復盤",
      model: "gpt-5.5",
      candleLimit: 520,
      maxOutputTokens: 3600,
      focus: "請像教練復盤一樣嚴格分析。除了盤勢與交易計劃，也要指出趨勢型態、K線型態、認知偏誤、可能過度交易的位置、停損停利是否對稱、以及可以轉成下次練習規則的具體建議。",
    },
  };

  function offlineReadSessions() {
    try {
      return JSON.parse(localStorage.getItem(OFFLINE_SESSION_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function offlineWriteSessions(sessions) {
    localStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(sessions));
  }

  async function offlineManifest() {
    if (offlineCache.manifest) return offlineCache.manifest;
    const response = await fetch("data/manifest.json");
    if (!response.ok) throw new Error("找不到離線資料 manifest");
    offlineCache.manifest = await response.json();
    return offlineCache.manifest;
  }

  async function offlineSymbolData(symbol, tradeDate) {
    const cleanSymbol = String(symbol || "").toUpperCase();
    const manifest = await offlineManifest();
    const item = manifest.symbols.find((candidate) => candidate.symbol === cleanSymbol);
    if (!item) throw new Error(`找不到 ${cleanSymbol} 的離線資料`);
    const selectedDate = tradeDate || item.dates[item.dates.length - 1];
    const year = String(selectedDate || "").slice(0, 4);
    const cacheKey = `${cleanSymbol}:${year}`;
    if (offlineCache.symbols.has(cacheKey)) return offlineCache.symbols.get(cacheKey);
    const response = await fetch(`data/${encodeURIComponent(cleanSymbol)}/${encodeURIComponent(year)}.json`);
    if (!response.ok) throw new Error(`找不到 ${cleanSymbol} ${year} 的離線資料`);
    const packed = await response.json();
    const candles = packed.candles.map((row) => ({
      time: row[0],
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
      tradeDate: packed.dates[row[6]],
    }));
    const data = { symbol: packed.symbol, dates: item.dates, loadedDates: packed.dates, year, candles };
    offlineCache.symbols.set(cacheKey, data);
    return data;
  }

  function offlineParseTimeframe(timeframe) {
    const text = String(timeframe || "1m").trim();
    const match = text.match(/^(\d+)([mhDWM])$/);
    if (!match) throw new Error(`Unsupported timeframe: ${timeframe}`);
    const value = Number(match[1]);
    const unit = match[2];
    if (unit === "h") return { value: value * 60, unit: "m" };
    return { value, unit };
  }

  function offlineCalendarBucket(candle, value, unit, anchorDate) {
    const current = new Date(`${candle.tradeDate}T00:00:00Z`);
    const anchor = new Date(`${anchorDate}T00:00:00Z`);
    if (unit === "D") return Math.floor((current - anchor) / 86400000 / value);
    if (unit === "W") return Math.floor((current - anchor) / 86400000 / 7 / value);
    if (unit === "M") {
      const currentMonths = current.getUTCFullYear() * 12 + current.getUTCMonth();
      const anchorMonths = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
      return Math.floor((currentMonths - anchorMonths) / value);
    }
    return 0;
  }

  function offlineResample(candles, timeframe) {
    const { value, unit } = offlineParseTimeframe(timeframe);
    if ((unit === "m" && value === 1) || !candles.length) return candles;
    const sampled = [];
    let current = null;
    let currentBucket = null;
    const anchorTime = candles[0].time;
    const anchorDate = candles[0].tradeDate;
    candles.forEach((candle) => {
      const bucket = unit === "m"
        ? anchorTime + Math.floor((candle.time - anchorTime) / (value * 60)) * value * 60
        : offlineCalendarBucket(candle, value, unit, anchorDate);
      if (bucket !== currentBucket) {
        if (current) sampled.push(current);
        currentBucket = bucket;
        current = {
          time: unit === "m" ? bucket : candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          tradeDate: candle.tradeDate,
          startTradeDate: candle.tradeDate,
          endTradeDate: candle.tradeDate,
        };
        return;
      }
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.volume += candle.volume;
      current.tradeDate = candle.tradeDate;
      current.endTradeDate = candle.tradeDate;
    });
    if (current) sampled.push(current);
    return sampled;
  }

  function offlineSelectedDateBounds(candles, tradeDate) {
    const indices = [];
    candles.forEach((candle, index) => {
      const start = candle.startTradeDate || candle.tradeDate;
      const end = candle.endTradeDate || candle.tradeDate;
      if (start <= tradeDate && tradeDate <= end) indices.push(index);
    });
    if (!indices.length) return { selectedDateStartIndex: 0, selectedDateEndIndex: Math.max(0, candles.length - 1) };
    return { selectedDateStartIndex: indices[0], selectedDateEndIndex: indices[indices.length - 1] };
  }

  async function offlineRandomSession(params) {
    const manifest = await offlineManifest();
    const symbol = params.get("symbol");
    const timeframe = params.get("timeframe") || "5m";
    const candidates = symbol ? manifest.symbols.filter((item) => item.symbol === symbol.toUpperCase()) : manifest.symbols;
    if (!candidates.length) throw new Error("沒有可抽題的離線標的");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const picked = candidates[Math.floor(Math.random() * candidates.length)];
      const pickedDates = picked.dates || [];
      const pickedDate = pickedDates[Math.floor(Math.random() * pickedDates.length)];
      const data = await offlineSymbolData(picked.symbol, pickedDate);
      const candles = offlineResample(data.candles, timeframe);
      if (candles.length < 20) continue;
      const bounds = offlineSelectedDateBounds(candles, pickedDate);
      const lower = Math.min(Math.max(10, bounds.selectedDateStartIndex), candles.length - 2);
      const upper = Math.max(lower, Math.min(candles.length - 2, bounds.selectedDateEndIndex));
      const startIndex = lower + Math.floor(Math.random() * (upper - lower + 1));
      const date = candles[startIndex].tradeDate;
      return {
        symbol: picked.symbol,
        date,
        timeframe,
        startIndex,
        contextDates: data.dates,
        scope: "offline",
        ...bounds,
      };
    }
    throw new Error("找不到足夠資料可抽題");
  }

  function offlineExtractOpenAIText(payload) {
    if (typeof payload.output_text === "string") return payload.output_text;
    const parts = [];
    (payload.output || []).forEach((item) => {
      (item.content || []).forEach((content) => {
        if (typeof content.text === "string") parts.push(content.text);
      });
    });
    return parts.join("\n").trim();
  }

  async function offlineCoach(payload) {
    const apiKey = localStorage.getItem(OFFLINE_OPENAI_KEY);
    if (!apiKey) throw new Error("尚未在此裝置設定 OpenAI API Key");
    const profileKey = String(payload.profile || "quick").toLowerCase();
    const profile = offlineCoachProfiles[profileKey] || offlineCoachProfiles.quick;
    const model = profile.model;
    const promptContext = {
      symbol: payload.symbol,
      tradeDate: payload.tradeDate,
      timeframe: payload.timeframe,
      replayIndex: payload.replayIndex,
      visibleRange: payload.visibleRange,
      coachProfile: profile.label,
      model,
      candles: (payload.candles || []).slice(-profile.candleLimit),
      annotations: payload.annotations || [],
      ranges: payload.ranges || [],
      tradePlans: payload.tradePlans || [],
      indicators: payload.indicators || {},
      stats: payload.stats || {},
    };
    const requestPayload = {
      model,
      input: [
        {
          role: "system",
          content: `你是一位嚴格但務實的盤中K線交易教練。根據使用者目前可見的K線、標註、區間與交易計劃，用繁體中文提供短而可執行的回饋。請聚焦趨勢結構、趨勢型態、K線型態、支撐壓力、追價風險、停損停利、持倉風險。${profile.focus}不要承諾獲利，不要給投資建議式保證。`,
        },
        {
          role: "user",
          content: `請以「${profile.label}」分析這份目前圖表狀態，輸出：\n1. 目前盤勢判讀（含趨勢型態與K線型態）\n2. 使用者標註可能的盲點\n3. 交易計劃風險\n4. 下一步應該觀察的2到4件事\n\n${JSON.stringify(promptContext)}`,
        },
      ],
      max_output_tokens: profile.maxOutputTokens,
    };
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `OpenAI API error ${response.status}`);
    const advice = offlineExtractOpenAIText(data);
    if (!advice) throw new Error("OpenAI API 沒有回傳文字內容");
    return {
      profile: profileKey,
      profileLabel: profile.label,
      model,
      advice,
      incomplete: data.status === "incomplete" || Boolean(data.incomplete_details),
    };
  }

  async function offlineApi(path, options = {}) {
    const url = new URL(path, location.href);
    const params = url.searchParams;
    if (url.pathname === "/api/symbols") {
      const manifest = await offlineManifest();
      return { symbols: manifest.symbols };
    }
    if (url.pathname === "/api/dates") {
      const manifest = await offlineManifest();
      const symbol = String(params.get("symbol") || "").toUpperCase();
      const item = manifest.symbols.find((candidate) => candidate.symbol === symbol);
      return { symbol, dates: item?.dates || [] };
    }
    if (url.pathname === "/api/candles") {
      const symbol = params.get("symbol");
      const tradeDate = params.get("date");
      const timeframe = params.get("timeframe") || "1m";
      const data = await offlineSymbolData(symbol, tradeDate);
      const candles = offlineResample(data.candles, timeframe);
      return {
        symbol: data.symbol,
        date: tradeDate,
        timeframe,
        exchangeTimezone: "America/New_York",
        candles,
        contextDates: data.dates,
        scope: "offline",
        ...offlineSelectedDateBounds(candles, tradeDate),
      };
    }
    if (url.pathname === "/api/random-session") return offlineRandomSession(params);
    if (url.pathname === "/api/sessions" && (options.method || "GET").toUpperCase() === "GET") {
      return { sessions: offlineReadSessions().slice(0, Number(params.get("limit") || 50)) };
    }
    if (url.pathname === "/api/sessions" && (options.method || "GET").toUpperCase() === "POST") {
      const payload = JSON.parse(options.body || "{}");
      const sessions = offlineReadSessions();
      const item = { ...payload, id: Date.now(), createdAt: new Date().toISOString() };
      sessions.unshift(item);
      offlineWriteSessions(sessions.slice(0, 200));
      return { id: item.id, createdAt: item.createdAt };
    }
    if (url.pathname === "/api/sessions" && (options.method || "GET").toUpperCase() === "DELETE") {
      const id = String(params.get("id"));
      offlineWriteSessions(offlineReadSessions().filter((item) => String(item.id) !== id));
      return { ok: true, id };
    }
    if (url.pathname === "/api/coach") return offlineCoach(JSON.parse(options.body || "{}"));
    if (url.pathname === "/api/health") return { ok: true, offline: true };
    throw new Error(`離線版不支援此 API: ${url.pathname}`);
  }


  const $ = (selector) => document.querySelector(selector);
  const ctx = $("#chartCanvas").getContext("2d");

  const els = {
    dataStatus: $("#dataStatus"),
    symbolSelect: $("#symbolSelect"),
    dateSelect: $("#dateSelect"),
    timeframeGroup: $("#timeframeGroup"),
    customTimeframeValue: $("#customTimeframeValue"),
    customTimeframeUnit: $("#customTimeframeUnit"),
    customTimeframeBtn: $("#customTimeframeBtn"),
    randomBtn: $("#randomBtn"),
    resetBtn: $("#resetBtn"),
    stepBackBtn: $("#stepBackBtn"),
    playBtn: $("#playBtn"),
    stepForwardBtn: $("#stepForwardBtn"),
    fullViewBtn: $("#fullViewBtn"),
    speedSelect: $("#speedSelect"),
    chartTitle: $("#chartTitle"),
    chartSubtitle: $("#chartSubtitle"),
    chartShell: $("#chartShell"),
    canvas: $("#chartCanvas"),
    indicatorValuePanel: $("#indicatorValuePanel"),
    tooltip: $("#crosshairTooltip"),
    replaySlider: $("#replaySlider"),
    progressText: $("#progressText"),
    newPlanBtn: $("#newPlanBtn"),
    planList: $("#planList"),
    portfolioStats: $("#portfolioStats"),
    saveSessionBtn: $("#saveSessionBtn"),
    smaPeriodInput: $("#smaPeriodInput"),
    addSmaBtn: $("#addSmaBtn"),
    smaList: $("#smaList"),
    volumeToggle: $("#volumeToggle"),
    vwapToggle: $("#vwapToggle"),
    macdToggle: $("#macdToggle"),
    kdToggle: $("#kdToggle"),
    rsiToggle: $("#rsiToggle"),
    cciToggle: $("#cciToggle"),
    coachButtons: document.querySelectorAll("[data-coach-mode]"),
    coachOutput: $("#coachOutput"),
    openaiKeyInput: $("#openaiKeyInput"),
    saveOpenaiKeyBtn: $("#saveOpenaiKeyBtn"),
    clearOpenaiKeyBtn: $("#clearOpenaiKeyBtn"),
    historyList: $("#historyList"),
    historyCount: $("#historyCount"),
    toast: $("#toast"),
    magnetToggleBtn: $("#magnetToggleBtn"),
    deleteSelectedBtn: $("#deleteSelectedBtn"),
    clearBtn: $("#clearBtn"),
  };

  const labels = {
    long: "多",
    short: "空",
    range: "盤整",
    chop: "震盪",
    reversal: "反轉",
    entry: "入場",
    exit: "出場",
    stop: "停損",
    target: "停利",
  };

  const rangeColors = {
    long: "rgba(200, 69, 69, 0.13)",
    short: "rgba(22, 133, 95, 0.13)",
    range: "rgba(195, 132, 29, 0.14)",
    chop: "rgba(38, 110, 241, 0.12)",
    reversal: "rgba(110, 86, 207, 0.13)",
    note: "rgba(38, 110, 241, 0.10)",
  };

  const lineColors = ["#c3841d", "#266ef1", "#6e56cf", "#16855f", "#c84545", "#0f766e"];
  const upColor = "#c84545";
  const downColor = "#16855f";

  const state = {
    symbols: [],
    dates: [],
    sessions: [],
    candles: [],
    symbol: "",
    tradeDate: "",
    timeframe: "5m",
    replayIndex: 0,
    openingIndex: 0,
    viewEnd: 1,
    barsPerScreen: 120,
    priceZoom: 1,
    pricePan: 0,
    indicatorOrder: ["volume", "macd", "kd", "rsi", "cci"],
    paneHeights: {
      volume: 76,
      macd: 82,
      kd: 82,
      rsi: 76,
      cci: 76,
    },
    playing: false,
    playTimer: null,
    tool: "cursor",
    snapToCandle: false,
    tradeAction: null,
    pending: null,
    hoverPoint: null,
    annotations: [],
    ranges: [],
    tradePlans: [],
    activePlanId: null,
    selectedDateStartIndex: 0,
    selectedDateEndIndex: 0,
    indicators: {
      smas: [
        { id: uid("sma"), period: 20, color: "#c3841d", visible: true },
        { id: uid("sma"), period: 50, color: "#6e56cf", visible: true },
      ],
    },
    selected: null,
    selectionBox: null,
    crosshair: null,
    pointer: null,
    drag: null,
    axisDrag: null,
    paneResize: null,
    lastScale: null,
  };

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function closestTarget(event, selector) {
    const target = event.target;
    if (!target) return null;
    if (typeof target.closest === "function") return target.closest(selector);
    return target.parentElement?.closest(selector) || null;
  }

  function stopControlEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }

  async function api(path, options) {
    if (OFFLINE_MODE) return offlineApi(path, options || {});
    const response = await fetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.remove("hidden");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => els.toast.classList.add("hidden"), 2600);
  }

  function setBusy(message) {
    els.dataStatus.textContent = message;
  }

  function formatPrice(value) {
    if (!Number.isFinite(value)) return "--";
    if (Math.abs(value) >= 100) return value.toFixed(2);
    if (Math.abs(value) >= 10) return value.toFixed(3);
    return value.toFixed(4);
  }

  function formatMoney(value) {
    if (!Number.isFinite(value)) return "--";
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}$${Math.abs(value).toFixed(2)}`;
  }

  function formatPct(value) {
    if (!Number.isFinite(value)) return "--";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  }

  function formatVolume(value) {
    if (!Number.isFinite(value)) return "--";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
    return value.toFixed(0);
  }

  function formatTime(timestamp, includeDate = false) {
    const date = new Date(timestamp * 1000);
    const options = includeDate
      ? { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
      : { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false };
    return new Intl.DateTimeFormat("zh-TW", options).format(date);
  }

  function numberFrom(input, fallback = 0) {
    const value = Number(input.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function timeframeMinutes(timeframe) {
    const match = String(timeframe || "1m").trim().match(/^(\d+)([mhDWM])$/);
    if (!match) return 5;
    const value = Number(match[1]);
    const unit = match[2];
    if (unit === "h") return value * 60;
    if (unit === "D") return value * 390;
    if (unit === "W") return value * 5 * 390;
    if (unit === "M") return value * 21 * 390;
    return value;
  }

  function customTimeframeValue() {
    const value = Math.round(numberFrom(els.customTimeframeValue, 0));
    const unit = ["m", "h", "D", "W", "M"].includes(els.customTimeframeUnit.value) ? els.customTimeframeUnit.value : "m";
    const minutes = value * (unit === "h" ? 60 : unit === "m" ? 1 : 0);
    if (!value) throw new Error("請輸入自訂週期");
    if ((unit === "m" || unit === "h") && (minutes < 1 || minutes > 390)) {
      throw new Error("自訂分鐘/小時週期需介於 1 到 390 分鐘");
    }
    if (unit === "D" && value > 260) throw new Error("自訂日週期需介於 1 到 260 日");
    if (unit === "W" && value > 104) throw new Error("自訂週期需介於 1 到 104 週");
    if (unit === "M" && value > 60) throw new Error("自訂月週期需介於 1 到 60 月");
    return `${value}${unit}`;
  }

  function stopPlayback() {
    state.playing = false;
    window.clearInterval(state.playTimer);
    state.playTimer = null;
    els.playBtn.textContent = "▶";
  }

  function revealEnd() {
    return Math.min(state.candles.length, state.replayIndex + 1);
  }

  function getVisibleBounds() {
    const endLimit = Math.max(1, revealEnd());
    const bars = clamp(Math.round(state.barsPerScreen), 24, 520);
    state.viewEnd = clamp(state.viewEnd || revealEnd(), 1, endLimit);
    let end = clamp(Math.round(state.viewEnd), 1, endLimit);
    const start = Math.max(0, end - bars);
    return { start, end, count: Math.max(1, end - start) };
  }

  function setReplayIndex(index, follow = true) {
    if (!state.candles.length) return;
    state.replayIndex = clamp(Math.round(index), 0, state.candles.length - 1);
    if (follow) state.viewEnd = state.replayIndex + 1;
    updateAll();
  }

  function setTool(tool) {
    state.tool = tool;
    state.tradeAction = null;
    state.pending = null;
    state.selectionBox = null;
    document.querySelectorAll(".tool[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === tool);
    });
    document.querySelectorAll("[data-plan-action]").forEach((button) => {
      button.classList.remove("active");
    });
  }

  function currentTradeAction() {
    if (!state.tradeAction) return null;
    if (typeof state.tradeAction === "string") {
      return { action: state.tradeAction, planId: state.activePlanId, qty: activePlan().qty || 100 };
    }
    return state.tradeAction;
  }

  function setTradeAction(action, planId = state.activePlanId) {
    const plan = state.tradePlans.find((item) => item.id === planId) || activePlan();
    const qty = Math.max(1, Math.round(Number(plan.qty) || 100));
    state.activePlanId = plan.id;
    state.tradeAction = { action, planId: plan.id, qty };
    state.tool = "cursor";
    state.pending = null;
    document.querySelectorAll(".tool[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === "cursor");
    });
    document.querySelectorAll("[data-plan-action]").forEach((button) => button.classList.remove("active"));
    renderPlans();
    showToast(`${plan.name || `計劃 ${planNumber(plan.id)}`}：在圖上點一下設定${labels[tradeActionPart(action)] || "價位"}`);
  }

  function setTimeframe(timeframe) {
    state.timeframe = timeframe;
    els.timeframeGroup.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", button.dataset.timeframe === timeframe);
    });
    const customMatch = String(timeframe).match(/^(\d+)([mhDWM])$/);
    if (customMatch && !els.timeframeGroup.querySelector(`button[data-timeframe="${timeframe}"]`)) {
      els.customTimeframeValue.value = customMatch[1];
      els.customTimeframeUnit.value = customMatch[2];
    }
  }

  async function applyCustomTimeframe() {
    try {
      setTimeframe(customTimeframeValue());
      await loadCandles();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function loadSymbols() {
    setBusy("讀取標的");
    const data = await api("/api/symbols");
    state.symbols = data.symbols || [];
    if (!state.symbols.length) throw new Error("找不到 data/historical_1min 裡的分K資料");
    els.symbolSelect.innerHTML = state.symbols
      .map((item) => `<option value="${escapeHtml(item.symbol)}">${escapeHtml(item.symbol)} · ${item.days}日</option>`)
      .join("");
    const preferred = state.symbols.reduce((best, item) => (!best || item.to > best.to ? item : best), null);
    state.symbol = preferred.symbol;
    els.symbolSelect.value = state.symbol;
  }

  async function loadDates(preferLatest = true) {
    const data = await api(`/api/dates?symbol=${encodeURIComponent(state.symbol)}`);
    state.dates = data.dates || [];
    els.dateSelect.innerHTML = state.dates.map((date) => `<option value="${escapeHtml(date)}">${escapeHtml(date)}</option>`).join("");
    if (!state.dates.length) throw new Error(`${state.symbol} 沒有可用日期`);
    if (preferLatest || !state.dates.includes(state.tradeDate)) state.tradeDate = state.dates[state.dates.length - 1];
    els.dateSelect.value = state.tradeDate;
  }

  async function loadCandles(options = {}) {
    stopPlayback();
    setBusy(`載入 ${state.symbol} ${state.tradeDate}`);
    const params = new URLSearchParams({ symbol: state.symbol, date: state.tradeDate, timeframe: state.timeframe });
    const data = await api(`/api/candles?${params.toString()}`);
    state.candles = data.candles || [];
    state.selectedDateStartIndex = Number.isFinite(data.selectedDateStartIndex) ? data.selectedDateStartIndex : 0;
    state.selectedDateEndIndex = Number.isFinite(data.selectedDateEndIndex) ? data.selectedDateEndIndex : Math.max(0, state.candles.length - 1);
    state.annotations = [];
    state.ranges = [];
    state.tradePlans = [];
    state.activePlanId = null;
    state.selected = null;
    state.pending = null;
    state.tradeAction = null;
    state.crosshair = null;
    state.priceZoom = 1;
    state.pricePan = 0;
    state.barsPerScreen = timeframeMinutes(state.timeframe) <= 1 ? 160 : 120;
    createPlan(false);

    const sessionStart = clamp(state.selectedDateStartIndex, 0, Math.max(0, state.candles.length - 1));
    const sessionEnd = clamp(state.selectedDateEndIndex, sessionStart, Math.max(0, state.candles.length - 1));
    const sessionLength = Math.max(1, sessionEnd - sessionStart + 1);
    const fallbackIndex = clamp(sessionStart + Math.max(35, Math.floor(sessionLength * 0.28)), sessionStart, sessionEnd);
    state.openingIndex = clamp(options.startIndex ?? fallbackIndex, 0, Math.max(0, state.candles.length - 1));
    state.replayIndex = state.openingIndex;
    state.viewEnd = state.replayIndex + 1;
    updateAll();
    const contextText = data.contextDates?.length ? ` · 全部 ${data.contextDates.length} 日` : "";
    setBusy(`${state.symbol} · ${state.tradeDate} · ${state.candles.length} 根${contextText}`);
  }

  function currentCandle() {
    return state.candles[state.replayIndex];
  }

  function currentTradePoint() {
    const candle = currentCandle();
    if (!candle) return null;
    return {
      index: state.replayIndex,
      time: candle.time,
      price: candle.close,
      candle,
    };
  }

  function renderOhlc(candle) {
    void candle;
  }

  function updateChrome() {
    const candle = currentCandle();
    els.chartTitle.textContent = state.symbol ? `${state.symbol} ${state.timeframe}` : "--";
    els.chartSubtitle.textContent = state.tradeDate ? `${state.tradeDate} · 全部歷史RTH · New York time` : "--";
    els.replaySlider.max = Math.max(0, state.candles.length - 1);
    els.replaySlider.value = state.replayIndex;
    els.progressText.textContent = state.candles.length ? `${state.replayIndex + 1} / ${state.candles.length}` : "0 / 0";
    renderOhlc(candle);
  }

  function createPlan(makeActive = true) {
    const plan = {
      id: uid("plan"),
      name: `計劃 ${state.tradePlans.length + 1}`,
      notes: "",
      qty: 100,
      entry: null,
      exit: null,
      stop: null,
      target: null,
    };
    state.tradePlans.push(plan);
    if (makeActive || !state.activePlanId) state.activePlanId = plan.id;
    renderPlans();
    return plan;
  }

  function activePlan() {
    return state.tradePlans.find((plan) => plan.id === state.activePlanId) || state.tradePlans[0] || createPlan();
  }

  function placeTradePoint(point) {
    const actionState = currentTradeAction();
    if (!actionState) return;
    const plan = state.tradePlans.find((item) => item.id === actionState.planId) || activePlan();
    const action = actionState.action;
    const qty = Math.max(1, Math.round(Number(actionState.qty) || Number(plan.qty) || 100));
    state.activePlanId = plan.id;
    if (action === "entryLong" || action === "entryShort") {
      plan.entry = {
        index: point.index,
        time: point.time,
        price: point.price,
        qty,
        side: action === "entryLong" ? "long" : "short",
      };
    } else if (action === "exit") {
      plan.exit = { index: point.index, time: point.time, price: point.price, qty };
    } else if (action === "stop") {
      plan.stop = { index: point.index, time: point.time, price: point.price };
    } else if (action === "target") {
      plan.target = { index: point.index, time: point.time, price: point.price };
    }
    state.selected = { type: "trade", id: plan.id, part: tradeActionPart(action) };
    state.tradeAction = null;
    document.querySelectorAll("[data-plan-action]").forEach((button) => button.classList.remove("active"));
    updateAll();
  }

  function placeTradeAtCurrent(action, planId = state.activePlanId) {
    const point = currentTradePoint();
    if (!point) return;
    const plan = state.tradePlans.find((item) => item.id === planId) || activePlan();
    const qty = Math.max(1, Math.round(Number(plan.qty) || 100));
    state.tradeAction = { action, planId: plan.id, qty };
    placeTradePoint(point);
  }

  function applyPlanOrder(planId, order) {
    const plan = state.tradePlans.find((item) => item.id === planId) || activePlan();
    state.activePlanId = plan.id;
    if (order === "stop" || order === "target") {
      setTradeAction(order, plan.id);
      return;
    }
    if (order === "buy") {
      if (plan.entry?.side === "short" && !plan.exit) placeTradeAtCurrent("exit", plan.id);
      else placeTradeAtCurrent("entryLong", plan.id);
      return;
    }
    if (order === "sell") {
      if (plan.entry?.side === "long" && !plan.exit) placeTradeAtCurrent("exit", plan.id);
      else placeTradeAtCurrent("entryShort", plan.id);
    }
  }

  function tradeActionPart(action) {
    if (action === "entryLong" || action === "entryShort") return "entry";
    return action;
  }

  function signedDirection(plan) {
    return plan.entry?.side === "short" ? -1 : 1;
  }

  function planStats(plan) {
    const price = currentCandle()?.close ?? plan.entry?.price ?? 0;
    if (!plan.entry || state.replayIndex < plan.entry.index) {
      return {
        openQty: 0,
        avgCost: null,
        realized: 0,
        unrealized: 0,
        total: 0,
        pct: 0,
        exposure: 0,
        risk: 0,
        rewardRisk: null,
        barsHeld: 0,
        status: "未入場",
      };
    }

    const dir = signedDirection(plan);
    const entryQty = Math.max(0, Number(plan.entry.qty || 0));
    const exitActive = plan.exit && state.replayIndex >= plan.exit.index;
    const closedQty = exitActive ? Math.min(entryQty, Math.max(0, Number(plan.exit.qty || entryQty))) : 0;
    const openQty = entryQty - closedQty;
    const exitPrice = plan.exit?.price ?? price;
    const realized = exitActive ? (exitPrice - plan.entry.price) * closedQty * dir : 0;
    const unrealized = openQty > 0 ? (price - plan.entry.price) * openQty * dir : 0;
    const total = realized + unrealized;
    const basis = Math.max(0.0001, plan.entry.price * entryQty);
    const riskPerShare = plan.stop ? Math.max(0, (plan.entry.price - plan.stop.price) * dir) : 0;
    const rewardPerShare = plan.target ? Math.max(0, (plan.target.price - plan.entry.price) * dir) : 0;
    const risk = riskPerShare * entryQty;
    const rewardRisk = riskPerShare > 0 ? rewardPerShare / riskPerShare : null;
    const endIndex = exitActive ? plan.exit.index : state.replayIndex;
    const slice = state.candles.slice(plan.entry.index, endIndex + 1);
    const mfe = slice.length ? Math.max(...slice.map((c) => (c.high - plan.entry.price) * dir)) * entryQty : 0;
    const mae = slice.length ? Math.min(...slice.map((c) => (c.low - plan.entry.price) * dir)) * entryQty : 0;
    return {
      openQty: openQty * dir,
      avgCost: plan.entry.price,
      realized,
      unrealized,
      total,
      pct: (total / basis) * 100,
      exposure: Math.abs(openQty * price),
      risk,
      rewardRisk,
      barsHeld: Math.max(0, endIndex - plan.entry.index),
      mfe,
      mae,
      status: openQty ? "持倉中" : "已出場",
    };
  }

  function portfolioStats() {
    return state.tradePlans.reduce(
      (acc, plan) => {
        const stats = planStats(plan);
        acc.openQty += stats.openQty;
        acc.exposure += stats.exposure;
        acc.realized += stats.realized;
        acc.unrealized += stats.unrealized;
        acc.total += stats.total;
        acc.risk += stats.risk;
        if (stats.avgCost && Math.abs(stats.openQty) > 0) {
          acc.costBasis += Math.abs(stats.openQty) * stats.avgCost;
        }
        return acc;
      },
      { openQty: 0, exposure: 0, realized: 0, unrealized: 0, total: 0, risk: 0, costBasis: 0 }
    );
  }

  function renderPortfolio() {
    const stats = portfolioStats();
    const current = currentCandle()?.close ?? 0;
    const avg = Math.abs(stats.openQty) ? stats.costBasis / Math.abs(stats.openQty) : null;
    const totalPct = stats.costBasis ? (stats.total / stats.costBasis) * 100 : 0;
    els.portfolioStats.innerHTML = [
      statCell("持倉", `${stats.openQty.toFixed(0)} 股`),
      statCell("均價", avg ? formatPrice(avg) : "--"),
      statCell("現價", formatPrice(current)),
      statCell("未實現", formatMoney(stats.unrealized)),
      statCell("已實現", formatMoney(stats.realized)),
      statCell("總損益", `${formatMoney(stats.total)} · ${formatPct(totalPct)}`),
      statCell("曝險", formatMoney(stats.exposure)),
      statCell("計劃風險", formatMoney(stats.risk)),
    ].join("");
  }

  function statCell(label, value) {
    return `<div class="stat-cell"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function planNumber(planId) {
    const index = state.tradePlans.findIndex((plan) => plan.id === planId);
    return index >= 0 ? index + 1 : "?";
  }

  function isSelected(type, id, part = null) {
    if (!state.selected) return false;
    if (state.selected.type === "group") {
      return state.selected.items.some(
        (item) => item.type === type && item.id === id && (part === null || item.part === part)
      );
    }
    return (
      state.selected.type === type &&
      state.selected.id === id &&
      (part === null || state.selected.part === part)
    );
  }

  function renderPlans() {
    if (!state.tradePlans.length) createPlan(false);
    const actionState = currentTradeAction();
    els.planList.innerHTML = state.tradePlans
      .map((item, index) => {
        item.qty = Math.max(1, Math.round(Number(item.qty) || item.entry?.qty || 100));
        const stats = planStats(item);
        const statusText = stats.status;
        const entry = item.entry ? `${formatTime(item.entry.time, true)} ｜ ${formatPrice(item.entry.price)}` : "--";
        const exit = item.exit ? `${formatTime(item.exit.time, true)} ｜ ${formatPrice(item.exit.price)}` : "--";
        const orderButton = (order, text) => {
          const active = actionState?.planId === item.id && actionState?.action === order ? " active" : "";
          return `<button type="button" class="${active}" data-plan-order="${item.id}:${order}">${text}</button>`;
        };
        return `<article class="plan-card ${item.id === state.activePlanId ? "active" : ""}" data-plan-id="${item.id}">
          <div class="plan-summary-line">
            <span><strong>計劃${index + 1}</strong>｜${escapeHtml(statusText)}｜入：${escapeHtml(entry)}，出：${escapeHtml(exit)}｜損益 ${escapeHtml(formatMoney(stats.total))}，${escapeHtml(formatPct(stats.pct))}｜</span>
            <button type="button" class="plan-delete-btn" data-plan-delete="${item.id}">刪</button>
          </div>
          <div class="plan-exec-line">
            <label class="plan-qty-field">
              <span>股數</span>
              <input data-plan-qty="${item.id}" inputmode="numeric" value="${item.qty}" />
            </label>
            ${orderButton("buy", "買進")}
            ${orderButton("sell", "賣出")}
            <span class="plan-divider">｜</span>
            ${orderButton("stop", "停損")}
            ${orderButton("target", "停利")}
          </div>
          <label class="notes-label plan-notes">
            <textarea data-plan-notes="${item.id}" rows="2" placeholder="筆記">${escapeHtml(item.notes || "")}</textarea>
          </label>
        </article>`;
      })
      .join("");
    renderPortfolio();
  }

  function deletePlan(planId) {
    state.tradePlans = state.tradePlans.filter((plan) => plan.id !== planId);
    state.activePlanId = state.tradePlans[0]?.id || null;
    state.selected = null;
    state.tradeAction = state.tradeAction?.planId === planId ? null : state.tradeAction;
    if (!state.tradePlans.length) createPlan(false);
    updateAll();
  }

  function deletePlanFrame(planId, part) {
    const plan = state.tradePlans.find((item) => item.id === planId);
    state.activePlanId = planId;
    if (plan && part) plan[part] = null;
    if (state.selected?.type === "trade" && state.selected.id === planId && state.selected.part === part) {
      state.selected = null;
    }
    updateAll();
  }

  function syncPlanQty(planId, rawValue) {
    const plan = state.tradePlans.find((item) => item.id === planId);
    if (!plan) return;
    plan.qty = Math.max(1, Math.round(Number(rawValue) || 1));
    if (state.tradeAction?.planId === plan.id) state.tradeAction.qty = plan.qty;
  }

  function syncPlanNotes(planId, value) {
    const plan = state.tradePlans.find((item) => item.id === planId);
    if (plan) plan.notes = value;
  }

  function deleteSma(smaId) {
    state.indicators.smas = state.indicators.smas.filter((sma) => sma.id !== smaId);
    updateAll();
  }

  function toggleSma(smaId) {
    const item = state.indicators.smas.find((sma) => sma.id === smaId);
    if (!item) return;
    item.visible = !item.visible;
    updateAll();
  }

  function setSmaColor(smaId, color, redrawOnly = false) {
    const item = state.indicators.smas.find((sma) => sma.id === smaId);
    if (!item) return;
    item.color = color;
    const input = [...els.smaList.querySelectorAll("[data-sma-color]")].find((element) => element.dataset.smaColor === smaId);
    input?.closest(".pill")?.style.setProperty("--pill-color", color);
    if (redrawOnly) draw();
    else updateAll();
  }

  function moveIndicatorPane(name, direction) {
    const index = state.indicatorOrder.indexOf(name);
    if (index < 0) return;
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= state.indicatorOrder.length) return;
    const order = [...state.indicatorOrder];
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    state.indicatorOrder = order;
    draw();
  }

  function setPaneHeight(name, value) {
    if (!state.paneHeights[name]) return;
    state.paneHeights[name] = clamp(Math.round(Number(value) || state.paneHeights[name]), 48, 180);
    const input = document.querySelector(`[data-pane-height="${name}"]`);
    if (input) input.value = String(state.paneHeights[name]);
    draw();
  }

  function bindPlanControls() {
    renderPlans();
  }

  function updateSelectedPanel() {
    return state.selected;
  }

  function renderSmaList() {
    els.smaList.innerHTML = state.indicators.smas
      .map(
        (item) => `<span class="pill sma-pill" style="--pill-color:${escapeHtml(item.color)}">
          <label data-sma-toggle="${item.id}">
            <input type="checkbox" data-sma-visible="${item.id}" ${item.visible ? "checked" : ""} />
            SMA ${item.period}
          </label>
          <input class="sma-color" type="color" data-sma-color="${item.id}" value="${escapeHtml(item.color)}" title="更換 SMA 顏色" />
          <span class="sma-swatches">
            ${lineColors.map((color) => `<button type="button" data-sma-color-pick="${item.id}:${color}" style="--swatch:${color}" title="套用 ${color}"></button>`).join("")}
          </span>
          <button type="button" data-sma-delete="${item.id}" title="刪除 SMA">×</button>
        </span>`
      )
      .join("");
  }

  function bindSmaControls() {
    renderSmaList();
  }

  function syncIndicatorControls() {
    document.querySelectorAll("[data-pane-height]").forEach((input) => {
      const name = input.dataset.paneHeight;
      input.value = String(state.paneHeights[name] || input.value);
    });
  }

  function updateAll() {
    updateChrome();
    renderPlans();
    renderSmaList();
    syncIndicatorControls();
    updateSelectedPanel();
    draw();
  }

  function maxSmaPeriod() {
    return Math.max(0, ...state.indicators.smas.map((item) => Number(item.period) || 0));
  }

  function indicatorWarmup(extra = 0) {
    return clamp(Math.max(360, maxSmaPeriod() * 3, extra), 120, 2400);
  }

  function indicatorSlice(scale, extra = 0, endIndex = null) {
    const visibleStart = scale?.start ?? Math.max(0, state.replayIndex - 1);
    const desiredEnd = endIndex === null ? Math.min(scale?.end ?? revealEnd(), revealEnd()) : endIndex + 1;
    const end = clamp(desiredEnd, 1, Math.max(1, state.candles.length));
    const offset = Math.max(0, visibleStart - indicatorWarmup(extra));
    return { candles: state.candles.slice(offset, end), offset };
  }

  function activeIndicatorPanes() {
    const active = [];
    if (els.volumeToggle.checked) active.push("volume");
    if (els.macdToggle.checked) active.push("macd");
    if (els.kdToggle.checked) active.push("kd");
    if (els.rsiToggle.checked) active.push("rsi");
    if (els.cciToggle.checked) active.push("cci");
    return state.indicatorOrder.filter((name) => active.includes(name));
  }

  function movingAverage(candles, period) {
    const values = new Array(candles.length).fill(null);
    let sum = 0;
    for (let i = 0; i < candles.length; i += 1) {
      sum += candles[i].close;
      if (i >= period) sum -= candles[i - period].close;
      if (i >= period - 1) values[i] = sum / period;
    }
    return values;
  }

  function exponentialAverage(candles, period) {
    const values = new Array(candles.length).fill(null);
    const alpha = 2 / (period + 1);
    let ema = null;
    for (let i = 0; i < candles.length; i += 1) {
      const close = candles[i].close;
      ema = ema === null ? close : close * alpha + ema * (1 - alpha);
      if (i >= period - 1) values[i] = ema;
    }
    return values;
  }

  function vwap(candles) {
    const values = new Array(candles.length).fill(null);
    let pv = 0;
    let volume = 0;
    for (let i = 0; i < candles.length; i += 1) {
      const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
      pv += typical * candles[i].volume;
      volume += candles[i].volume;
      values[i] = volume ? pv / volume : null;
    }
    return values;
  }

  function macd(candles) {
    const ema12 = exponentialAverage(candles, 12);
    const ema26 = exponentialAverage(candles, 26);
    const line = candles.map((_, i) => (ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null));
    const compact = line.map((value) => ({ close: value ?? 0 }));
    const signal = exponentialAverage(compact, 9).map((value, i) => (line[i] === null ? null : value));
    const hist = line.map((value, i) => (value !== null && signal[i] !== null ? value - signal[i] : null));
    return { line, signal, hist };
  }

  function kd(candles, period = 9) {
    const k = new Array(candles.length).fill(null);
    const d = new Array(candles.length).fill(null);
    let prevK = 50;
    let prevD = 50;
    for (let i = 0; i < candles.length; i += 1) {
      if (i < period - 1) continue;
      const slice = candles.slice(i - period + 1, i + 1);
      const high = Math.max(...slice.map((c) => c.high));
      const low = Math.min(...slice.map((c) => c.low));
      const rsv = high === low ? 50 : ((candles[i].close - low) / (high - low)) * 100;
      prevK = prevK * (2 / 3) + rsv * (1 / 3);
      prevD = prevD * (2 / 3) + prevK * (1 / 3);
      k[i] = prevK;
      d[i] = prevD;
    }
    return { k, d };
  }

  function rsi(candles, period = 14) {
    const values = new Array(candles.length).fill(null);
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < candles.length; i += 1) {
      const diff = candles[i].close - candles[i - 1].close;
      if (i <= period) {
        gains += Math.max(diff, 0);
        losses += Math.max(-diff, 0);
        if (i === period) {
          const rs = losses === 0 ? 100 : gains / losses;
          values[i] = 100 - 100 / (1 + rs);
        }
      } else {
        gains = (gains * (period - 1) + Math.max(diff, 0)) / period;
        losses = (losses * (period - 1) + Math.max(-diff, 0)) / period;
        const rs = losses === 0 ? 100 : gains / losses;
        values[i] = 100 - 100 / (1 + rs);
      }
    }
    return values;
  }

  function cci(candles, period = 20) {
    const values = new Array(candles.length).fill(null);
    const typicals = candles.map((c) => (c.high + c.low + c.close) / 3);
    for (let i = period - 1; i < candles.length; i += 1) {
      const slice = typicals.slice(i - period + 1, i + 1);
      const avg = slice.reduce((sum, value) => sum + value, 0) / period;
      const dev = slice.reduce((sum, value) => sum + Math.abs(value - avg), 0) / period;
      values[i] = dev ? (typicals[i] - avg) / (0.015 * dev) : 0;
    }
    return values;
  }

  function priceToY(price, scale = state.lastScale) {
    return scale.priceTop + ((scale.maxPrice - price) / (scale.maxPrice - scale.minPrice || 1)) * scale.priceHeight;
  }

  function yToPrice(y, scale = state.lastScale) {
    const ratio = (y - scale.priceTop) / (scale.priceHeight || 1);
    return scale.maxPrice - ratio * (scale.maxPrice - scale.minPrice);
  }

  function indexToX(index, scale = state.lastScale) {
    return scale.plotLeft + (index - scale.start + 0.5) * scale.barSpacing;
  }

  function xToIndex(x, scale = state.lastScale) {
    return clamp(Math.round(scale.start + (x - scale.plotLeft) / scale.barSpacing - 0.5), 0, state.candles.length - 1);
  }

  function interpolatePrice(a, b, index) {
    if (a.index === b.index) return a.price;
    const ratio = (index - a.index) / (b.index - a.index);
    return a.price + (b.price - a.price) * ratio;
  }

  function draw() {
    const rect = els.chartShell.getBoundingClientRect();
    const width = Math.max(320, rect.width);
    const height = Math.max(320, rect.height);
    const dpr = window.devicePixelRatio || 1;
    if (els.canvas.width !== Math.floor(width * dpr) || els.canvas.height !== Math.floor(height * dpr)) {
      els.canvas.width = Math.floor(width * dpr);
      els.canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#fbfcfd";
    ctx.fillRect(0, 0, width, height);
    if (!state.candles.length) {
      ctx.fillStyle = "#727982";
      ctx.textAlign = "center";
      ctx.fillText("沒有可顯示的K線", width / 2, height / 2);
      return;
    }

    const bounds = getVisibleBounds();
    const activePanes = activeIndicatorPanes();

    const margin = { left: 14, right: 70, top: 14, bottom: 26 };
    const paneGap = activePanes.length ? 10 : 0;
    const desiredPaneTotal = activePanes.reduce((sum, name) => sum + (state.paneHeights[name] || 76), 0);
    const maxPaneTotal = Math.max(0, height - margin.top - margin.bottom - 170 - paneGap * activePanes.length);
    const paneScale = desiredPaneTotal > maxPaneTotal && desiredPaneTotal > 0 ? maxPaneTotal / desiredPaneTotal : 1;
    const scaledPaneHeights = activePanes.map((name) => (state.paneHeights[name] || 76) * paneScale);
    const lowerTotal = activePanes.length ? scaledPaneHeights.reduce((sum, value) => sum + value, 0) + paneGap * activePanes.length : 0;
    const priceTop = margin.top;
    const priceBottom = height - margin.bottom - lowerTotal - (activePanes.length ? 12 : 0);
    const priceHeight = Math.max(140, priceBottom - priceTop);
    const plotLeft = margin.left;
    const plotRight = width - margin.right;
    const plotWidth = Math.max(180, plotRight - plotLeft);

    const visible = state.candles.slice(bounds.start, bounds.end);
    let minPrice = Math.min(...visible.map((c) => c.low));
    let maxPrice = Math.max(...visible.map((c) => c.high));
    state.annotations.forEach((item) => {
      if (item.type === "hline") {
        minPrice = Math.min(minPrice, item.price);
        maxPrice = Math.max(maxPrice, item.price);
      }
      if (item.type === "trend" || item.type === "extend" || item.type === "channel") {
        item.points?.forEach((p) => {
          minPrice = Math.min(minPrice, p.price);
          maxPrice = Math.max(maxPrice, p.price);
          if (item.type === "channel") {
            minPrice = Math.min(minPrice, p.price + item.offset);
            maxPrice = Math.max(maxPrice, p.price + item.offset);
          }
        });
      }
    });
    state.tradePlans.forEach((plan) => ["stop", "target"].forEach((part) => {
      if (plan[part]) {
        minPrice = Math.min(minPrice, plan[part].price);
        maxPrice = Math.max(maxPrice, plan[part].price);
      }
    }));
    const pad = Math.max((maxPrice - minPrice) * 0.08, maxPrice * 0.001, 0.01);
    minPrice -= pad;
    maxPrice += pad;
    const priceCenter = (minPrice + maxPrice) / 2;
    const priceRange = Math.max(maxPrice - minPrice, 0.0001);
    const scaledRange = priceRange / clamp(state.priceZoom || 1, 0.25, 10);
    minPrice = priceCenter - scaledRange / 2;
    maxPrice = priceCenter + scaledRange / 2;
    minPrice += state.pricePan || 0;
    maxPrice += state.pricePan || 0;

    const panes = {};
    let paneTop = priceBottom + 12;
    activePanes.forEach((name, index) => {
      const scaledHeight = scaledPaneHeights[index];
      panes[name] = { name, top: paneTop, bottom: paneTop + scaledHeight, height: scaledHeight };
      paneTop += scaledHeight + paneGap;
    });
    const scale = {
      width,
      height,
      start: bounds.start,
      end: bounds.end,
      count: bounds.count,
      plotLeft,
      plotRight,
      plotWidth,
      priceTop,
      priceBottom,
      priceHeight,
      minPrice,
      maxPrice,
      barSpacing: plotWidth / bounds.count,
      panes,
    };
    state.lastScale = scale;

    drawRanges(scale);
    drawPriceGrid(scale);
    drawCandles(scale);
    drawOverlays(scale);
    drawAnnotations(scale);
    drawTradePlans(scale);
    drawPending(scale);
    drawSelectionBox();
    drawLowerPanes(scale);
    drawCrosshair(scale);
    drawTopInfo(scale);
  }

  function drawPriceGrid(scale) {
    ctx.save();
    ctx.strokeStyle = "#e5e9ee";
    ctx.fillStyle = "#727982";
    ctx.lineWidth = 1;
    ctx.font = "12px system-ui, sans-serif";
    for (let i = 0; i <= 5; i += 1) {
      const y = scale.priceTop + (scale.priceHeight / 5) * i;
      const price = scale.maxPrice - ((scale.maxPrice - scale.minPrice) / 5) * i;
      ctx.beginPath();
      ctx.moveTo(scale.plotLeft, y);
      ctx.lineTo(scale.plotRight, y);
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(formatPrice(price), scale.plotRight + 8, y);
    }
    const ticks = Math.min(7, scale.count);
    for (let i = 0; i < ticks; i += 1) {
      const index = Math.round(scale.start + ((scale.count - 1) / Math.max(1, ticks - 1)) * i);
      const candle = state.candles[index];
      if (!candle) continue;
      const x = indexToX(index, scale);
      ctx.beginPath();
      ctx.moveTo(x, scale.priceTop);
      ctx.lineTo(x, scale.height - 24);
      ctx.stroke();
      ctx.textAlign = i === ticks - 1 ? "right" : "center";
      ctx.textBaseline = "bottom";
      const prev = state.candles[Math.max(0, index - 1)];
      const showDate = i === 0 || i === ticks - 1 || (prev && candle.tradeDate !== prev.tradeDate);
      ctx.fillText(formatTime(candle.time, showDate), x, scale.height - 6);
    }
    ctx.restore();
  }

  function infoIndex() {
    return clamp(state.hoverPoint?.index ?? state.replayIndex, 0, revealEnd() - 1);
  }

  function drawTopInfo(scale) {
    const index = infoIndex();
    const candle = state.candles[index];
    if (!candle) return;
    const source = indicatorSlice({ start: Math.max(0, index - 1), end: index + 1 }, 900, index);
    const localIndex = index - source.offset;
    const ohlcv = [
      formatTime(candle.time, true),
      `O ${formatPrice(candle.open)}`,
      `H ${formatPrice(candle.high)}`,
      `L ${formatPrice(candle.low)}`,
      `C ${formatPrice(candle.close)}`,
      `V ${formatVolume(candle.volume)}`,
    ];
    ctx.save();
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(23,25,28,0.82)";
    ctx.fillText(ohlcv.join("   "), scale.plotLeft + 4, scale.priceTop + 5);

    let x = scale.plotLeft + 4;
    const y = scale.priceTop + 23;
    state.indicators.smas.filter((item) => item.visible).forEach((item) => {
      const values = movingAverage(source.candles, item.period);
      const text = `SMA ${item.period} ${formatPrice(values[localIndex])}`;
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(x + 4, y + 6, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(23,25,28,0.78)";
      ctx.fillText(text, x + 11, y);
      x += ctx.measureText(text).width + 28;
    });
    if (els.vwapToggle.checked) {
      const value = vwap(source.candles)[localIndex];
      const text = `VWAP ${formatPrice(value)}`;
      ctx.fillStyle = "#0f766e";
      ctx.beginPath();
      ctx.arc(x + 4, y + 6, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(23,25,28,0.78)";
      ctx.fillText(text, x + 11, y);
    }
    ctx.restore();
  }

  function drawCandles(scale) {
    const width = clamp(scale.barSpacing * 0.62, 1.4, 13);
    for (let index = scale.start; index < scale.end; index += 1) {
      const candle = state.candles[index];
      const x = indexToX(index, scale);
      const yOpen = priceToY(candle.open, scale);
      const yClose = priceToY(candle.close, scale);
      const yHigh = priceToY(candle.high, scale);
      const yLow = priceToY(candle.low, scale);
      const up = candle.close >= candle.open;
      const color = up ? upColor : downColor;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();
      ctx.fillRect(x - width / 2, Math.min(yOpen, yClose), width, Math.max(1, Math.abs(yClose - yOpen)));
    }
  }

  function drawOverlays(scale) {
    const source = indicatorSlice(scale, maxSmaPeriod() * 3 + 80);
    state.indicators.smas.filter((item) => item.visible).forEach((item) => {
      drawLineSeries(movingAverage(source.candles, item.period), scale, item.color, 1.7, source.offset);
    });
    if (els.vwapToggle.checked) drawLineSeries(vwap(source.candles), scale, "#0f766e", 1.6, source.offset);
  }

  function drawLineSeries(values, scale, color, width = 1.5, offset = 0) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let started = false;
    for (let index = scale.start; index < scale.end; index += 1) {
      const value = values[index - offset];
      if (!Number.isFinite(value)) {
        started = false;
        continue;
      }
      const x = indexToX(index, scale);
      const y = priceToY(value, scale);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawRanges(scale) {
    ctx.save();
    ctx.font = "12px system-ui, sans-serif";
    state.ranges.forEach((range) => {
      const start = Math.min(range.startIndex, range.endIndex);
      const end = Math.max(range.startIndex, range.endIndex);
      if (end < scale.start || start >= scale.end) return;
      const x1 = indexToX(Math.max(start, scale.start), scale) - scale.barSpacing / 2;
      const x2 = indexToX(Math.min(end, scale.end - 1), scale) + scale.barSpacing / 2;
      ctx.fillStyle = range.color || rangeColors[range.kind] || rangeColors.note;
      ctx.fillRect(x1, scale.priceTop, x2 - x1, scale.priceHeight);
      ctx.strokeStyle = isSelected("range", range.id) ? "#15171b" : "rgba(24,31,42,0.25)";
      ctx.strokeRect(x1, scale.priceTop, x2 - x1, scale.priceHeight);
      ctx.fillStyle = "#15171b";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(range.text || labels[range.kind] || "區間", x1 + 5, scale.priceTop + 5);
    });
    ctx.restore();
  }

  function drawAnnotations(scale) {
    ctx.save();
    ctx.font = "12px system-ui, sans-serif";
    state.annotations.forEach((item) => {
      const selected = isSelected("annotation", item.id);
      ctx.lineWidth = selected ? 2.4 : 1.6;
      ctx.strokeStyle = item.color || "#266ef1";
      ctx.fillStyle = item.color || "#266ef1";
      if (item.type === "hline") {
        const y = priceToY(item.price, scale);
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(scale.plotLeft, y);
        ctx.lineTo(scale.plotRight, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.textAlign = "right";
        ctx.fillText(formatPrice(item.price), scale.plotRight - 4, y - 4);
      }
      if (item.type === "trend" || item.type === "extend") {
        drawTrendLike(item.points[0], item.points[1], scale, item.type === "extend");
        drawHandles(item.points, scale, selected);
      }
      if (item.type === "channel") {
        const [a, b] = item.points;
        drawTrendLike(a, b, scale, false);
        drawTrendLike({ ...a, price: a.price + item.offset }, { ...b, price: b.price + item.offset }, scale, false);
        const ax = indexToX(a.index, scale);
        const bx = indexToX(b.index, scale);
        const y1 = priceToY(a.price, scale);
        const y2 = priceToY(b.price, scale);
        const y3 = priceToY(b.price + item.offset, scale);
        const y4 = priceToY(a.price + item.offset, scale);
        ctx.fillStyle = "rgba(38,110,241,0.08)";
        ctx.beginPath();
        ctx.moveTo(ax, y1);
        ctx.lineTo(bx, y2);
        ctx.lineTo(bx, y3);
        ctx.lineTo(ax, y4);
        ctx.closePath();
        ctx.fill();
        drawHandles([a, b, { index: b.index, price: b.price + item.offset }], scale, selected);
      }
    });
    ctx.restore();
  }

  function drawTrendLike(a, b, scale, extended) {
    let x1 = indexToX(a.index, scale);
    let y1 = priceToY(a.price, scale);
    let x2 = indexToX(b.index, scale);
    let y2 = priceToY(b.price, scale);
    if (extended && x1 !== x2) {
      const slope = (y2 - y1) / (x2 - x1);
      const leftY = y1 + slope * (scale.plotLeft - x1);
      const rightY = y1 + slope * (scale.plotRight - x1);
      x1 = scale.plotLeft;
      y1 = leftY;
      x2 = scale.plotRight;
      y2 = rightY;
    }
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function drawHandles(points, scale, selected) {
    if (!selected) return;
    ctx.save();
    ctx.fillStyle = "#15171b";
    points.forEach((point) => {
      ctx.beginPath();
      ctx.arc(indexToX(point.index, scale), priceToY(point.price, scale), 4, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawPending(scale) {
    if (!state.pending || !state.hoverPoint) return;
    ctx.save();
    ctx.strokeStyle = "#15171b";
    ctx.fillStyle = "rgba(21,23,27,0.08)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    const p = state.pending.points;
    if ((state.pending.tool === "trend" || state.pending.tool === "extend") && p.length === 1) {
      drawTrendLike(p[0], state.hoverPoint, scale, state.pending.tool === "extend");
    }
    if (state.pending.tool === "channel") {
      if (p.length === 1) drawTrendLike(p[0], state.hoverPoint, scale, false);
      if (p.length === 2) {
        const basePrice = interpolatePrice(p[0], p[1], state.hoverPoint.index);
        const offset = state.hoverPoint.price - basePrice;
        drawTrendLike(p[0], p[1], scale, false);
        drawTrendLike({ ...p[0], price: p[0].price + offset }, { ...p[1], price: p[1].price + offset }, scale, false);
      }
    }
    if (state.pending.tool === "range" && p.length === 1) {
      const x1 = indexToX(p[0].index, scale);
      const x2 = indexToX(state.hoverPoint.index, scale);
      ctx.fillRect(Math.min(x1, x2), scale.priceTop, Math.abs(x2 - x1), scale.priceHeight);
      ctx.strokeRect(Math.min(x1, x2), scale.priceTop, Math.abs(x2 - x1), scale.priceHeight);
    }
    ctx.restore();
  }

  function drawSelectionBox() {
    if (!state.selectionBox) return;
    const { start, current } = state.selectionBox;
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const w = Math.abs(current.x - start.x);
    const h = Math.abs(current.y - start.y);
    ctx.save();
    ctx.fillStyle = "rgba(38, 110, 241, 0.08)";
    ctx.strokeStyle = "#266ef1";
    ctx.setLineDash([5, 4]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function drawTradePlans(scale) {
    ctx.save();
    ctx.font = "12px system-ui, sans-serif";
    state.tradePlans.forEach((plan) => {
      drawTradePart(plan, "stop", scale);
      drawTradePart(plan, "target", scale);
    });
    ctx.restore();
  }

  function drawTradePart(plan, part, scale) {
    const point = plan[part];
    if (!point || point.index < scale.start || point.index >= scale.end) return;
    const x = indexToX(point.index, scale);
    const y = priceToY(point.price, scale);
    const selected = isSelected("trade", plan.id, part);
    const color = part === "entry" ? (plan.entry.side === "long" ? upColor : downColor) : part === "exit" ? "#15171b" : part === "stop" ? "#c84545" : "#16855f";
    const planLabel = `計${planNumber(plan.id)}`;
    ctx.fillStyle = color;
    ctx.strokeStyle = selected ? "#15171b" : color;
    ctx.lineWidth = selected ? 3 : 1.5;
    if (part === "entry" || part === "exit") {
      ctx.beginPath();
      ctx.arc(x, y, selected ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#15171b";
      ctx.fillText(`${planLabel} ${part === "entry" ? (plan.entry.side === "long" ? "買" : "空") : "出"}`, x + 8, y - 8);
    } else {
      ctx.setLineDash(part === "stop" ? [5, 4] : [2, 4]);
      ctx.beginPath();
      ctx.moveTo(scale.plotLeft, y);
      ctx.lineTo(scale.plotRight, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(`${planLabel} ${labels[part]}`, x + 6, y - 6);
    }
  }

  function drawLowerPanes(scale) {
    const source = indicatorSlice(scale, 520);
    const localIndex = infoIndex() - source.offset;
    if (scale.panes.volume) drawVolumePane(scale.panes.volume, scale);
    if (scale.panes.macd) {
      const values = macd(source.candles);
      const text = `MACD ${formatPrice(values.line[localIndex])}   Signal ${formatPrice(values.signal[localIndex])}   Hist ${formatPrice(values.hist[localIndex])}`;
      drawMacdPane(values, scale.panes.macd, scale, source.offset, text);
    }
    if (scale.panes.kd) {
      const values = kd(source.candles);
      drawBoundedPane("KD", values, scale.panes.kd, scale, 0, 100, source.offset, `K ${formatPrice(values.k[localIndex])}   D ${formatPrice(values.d[localIndex])}`);
    }
    if (scale.panes.rsi) {
      const values = rsi(source.candles);
      drawSinglePane("RSI", values, scale.panes.rsi, scale, 0, 100, "#6e56cf", source.offset, formatPrice(values[localIndex]));
    }
    if (scale.panes.cci) {
      const values = cci(source.candles);
      drawSinglePane("CCI", values, scale.panes.cci, scale, -200, 200, "#c3841d", source.offset, formatPrice(values[localIndex]));
    }
  }

  function paneY(value, pane, min, max) {
    return pane.top + ((max - value) / (max - min || 1)) * pane.height;
  }

  function drawPaneFrame(name, pane, scale, min, max, valueText = "") {
    ctx.save();
    ctx.strokeStyle = "#e5e9ee";
    ctx.fillStyle = "#727982";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.beginPath();
    ctx.moveTo(scale.plotLeft, pane.top);
    ctx.lineTo(scale.plotRight, pane.top);
    ctx.moveTo(scale.plotLeft, pane.bottom);
    ctx.lineTo(scale.plotRight, pane.bottom);
    ctx.stroke();
    ctx.fillStyle = "#17191c";
    ctx.fillText(name, scale.plotLeft + 2, pane.top + 12);
    if (valueText) {
      ctx.fillStyle = "#727982";
      ctx.fillText(valueText, scale.plotLeft + 52, pane.top + 12);
    }
    ctx.fillStyle = "#727982";
    ctx.textAlign = "left";
    ctx.fillText(String(max), scale.plotRight + 8, pane.top + 8);
    ctx.fillText(String(min), scale.plotRight + 8, pane.bottom - 4);
    ctx.restore();
  }

  function drawVolumePane(pane, scale) {
    const index = infoIndex();
    drawPaneFrame("Volume", pane, scale, 0, "", formatVolume(state.candles[index]?.volume));
    const visible = state.candles.slice(scale.start, scale.end);
    const maxVolume = Math.max(...visible.map((c) => c.volume), 1);
    const width = clamp(scale.barSpacing * 0.6, 1, 13);
    for (let index = scale.start; index < scale.end; index += 1) {
      const candle = state.candles[index];
      const x = indexToX(index, scale);
      const h = (candle.volume / maxVolume) * pane.height;
      ctx.fillStyle = candle.close >= candle.open ? "rgba(200, 69, 69, 0.28)" : "rgba(22, 133, 95, 0.28)";
      ctx.fillRect(x - width / 2, pane.bottom - h, width, h);
    }
  }

  function drawMacdPane(values, pane, scale, offset = 0, valueText = "") {
    const all = [...values.line, ...values.signal, ...values.hist].filter(Number.isFinite);
    const max = Math.max(...all.map(Math.abs), 0.01);
    drawPaneFrame("MACD", pane, scale, (-max).toFixed(2), max.toFixed(2), valueText);
    const zero = paneY(0, pane, -max, max);
    ctx.strokeStyle = "#d8dde3";
    ctx.beginPath();
    ctx.moveTo(scale.plotLeft, zero);
    ctx.lineTo(scale.plotRight, zero);
    ctx.stroke();
    const width = clamp(scale.barSpacing * 0.55, 1, 10);
    for (let i = scale.start; i < scale.end; i += 1) {
      const value = values.hist[i - offset];
      if (!Number.isFinite(value)) continue;
      const x = indexToX(i, scale);
      const y = paneY(value, pane, -max, max);
      ctx.fillStyle = value >= 0 ? "rgba(200,69,69,0.55)" : "rgba(22,133,95,0.55)";
      ctx.fillRect(x - width / 2, Math.min(y, zero), width, Math.max(1, Math.abs(y - zero)));
    }
    drawPaneLine(values.line, pane, scale, -max, max, "#266ef1", offset);
    drawPaneLine(values.signal, pane, scale, -max, max, "#c3841d", offset);
  }

  function drawBoundedPane(name, values, pane, scale, min, max, offset = 0, valueText = "") {
    drawPaneFrame(name, pane, scale, min, max, valueText);
    drawPaneLine(values.k, pane, scale, min, max, "#266ef1", offset);
    drawPaneLine(values.d, pane, scale, min, max, "#c3841d", offset);
  }

  function drawSinglePane(name, values, pane, scale, min, max, color, offset = 0, valueText = "") {
    drawPaneFrame(name, pane, scale, min, max, valueText);
    drawPaneLine(values, pane, scale, min, max, color, offset);
  }

  function drawPaneLine(values, pane, scale, min, max, color, offset = 0) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let index = scale.start; index < scale.end; index += 1) {
      const value = values[index - offset];
      if (!Number.isFinite(value)) {
        started = false;
        continue;
      }
      const x = indexToX(index, scale);
      const y = paneY(value, pane, min, max);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawCrosshair(scale) {
    const point = state.crosshair;
    if (!point) return;
    if (point.x < scale.plotLeft || point.x > scale.plotRight || point.y < scale.priceTop || point.y > scale.height - 24) return;
    ctx.save();
    ctx.strokeStyle = "rgba(24,31,42,0.35)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(point.x, scale.priceTop);
    ctx.lineTo(point.x, scale.height - 24);
    ctx.moveTo(scale.plotLeft, point.y);
    ctx.lineTo(scale.plotRight, point.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function updateIndicatorValuePanel(scale) {
    void scale;
  }

  function eventPosition(event) {
    const rect = els.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function chartPointFromPosition(pos) {
    const scale = state.lastScale;
    if (!scale) return null;
    const index = clamp(xToIndex(pos.x, scale), 0, revealEnd() - 1);
    const candle = state.candles[index];
    if (!candle) return null;
    const point = { index, time: candle.time, price: yToPrice(pos.y, scale), candle };
    return state.snapToCandle ? snappedCandlePoint(point, pos, scale) : point;
  }

  function snappedCandlePoint(point, pos, scale = state.lastScale) {
    const maxIndex = revealEnd() - 1;
    let best = null;
    for (let index = Math.max(0, point.index - 2); index <= Math.min(maxIndex, point.index + 2); index += 1) {
      const candle = state.candles[index];
      if (!candle) continue;
      const x = indexToX(index, scale);
      const candidates = [
        { key: "high", price: candle.high },
        { key: "low", price: candle.low },
        { key: "open", price: candle.open },
        { key: "close", price: candle.close },
      ];
      candidates.forEach((candidate) => {
        const y = priceToY(candidate.price, scale);
        const distance = Math.hypot(pos.x - x, pos.y - y);
        if (distance <= 13 && (!best || distance < best.distance)) {
          best = { index, candle, price: candidate.price, distance };
        }
      });
    }
    if (!best) return point;
    return { index: best.index, time: best.candle.time, price: best.price, candle: best.candle, snapped: true };
  }

  function isPriceAxisPosition(pos, scale = state.lastScale) {
    if (!scale) return false;
    return pos.x >= scale.plotRight && pos.x <= scale.width && pos.y >= scale.priceTop && pos.y <= scale.priceBottom;
  }

  function paneDividerAt(pos, scale = state.lastScale) {
    if (!scale || pos.x < scale.plotLeft || pos.x > scale.plotRight) return null;
    return Object.values(scale.panes || {}).find((pane) => Math.abs(pos.y - pane.bottom) <= 6)?.name || null;
  }

  function updateTooltip(pos) {
    const point = chartPointFromPosition(pos);
    if (!point) {
      els.tooltip.classList.add("hidden");
      return;
    }
    const candle = point.candle;
    els.tooltip.textContent = `${formatTime(candle.time, true)} ｜ ${formatPrice(point.price)}`;
    const shell = els.chartShell.getBoundingClientRect();
    els.tooltip.style.left = `${clamp(pos.x + 14, 8, shell.width - 120)}px`;
    els.tooltip.style.top = `${clamp(pos.y + 14, 8, shell.height - 36)}px`;
    els.tooltip.classList.remove("hidden");
  }

  function handleChartClick(pos) {
    const point = chartPointFromPosition(pos);
    if (!point) return;
    if (state.tradeAction) {
      placeTradePoint(point);
      return;
    }
    if (state.tool === "cursor") {
      const hit = hitTest(pos);
      state.selected = hit ? hit.selected : null;
      updateAll();
      return;
    }
    if (state.tool === "hline") {
      state.annotations.push({ id: uid("ann"), type: "hline", price: point.price, color: lineColors[state.annotations.length % lineColors.length] });
      state.selected = { type: "annotation", id: state.annotations[state.annotations.length - 1].id, part: "body" };
      updateAll();
      return;
    }
    if (state.tool === "trend" || state.tool === "extend") {
      if (!state.pending) {
        state.pending = { tool: state.tool, points: [point] };
        showToast("已放起點，移動滑鼠可預覽，點第二下完成");
      } else {
        const item = { id: uid("ann"), type: state.tool, points: [state.pending.points[0], point], color: lineColors[state.annotations.length % lineColors.length] };
        state.annotations.push(item);
        state.selected = { type: "annotation", id: item.id, part: "p1" };
        state.pending = null;
      }
      updateAll();
      return;
    }
    if (state.tool === "channel") {
      if (!state.pending) {
        state.pending = { tool: "channel", points: [point] };
        showToast("已放通道起點");
      } else if (state.pending.points.length === 1) {
        state.pending.points.push(point);
        showToast("已放基準線終點，點第三下設定通道寬度");
      } else {
        const [a, b] = state.pending.points;
        const basePrice = interpolatePrice(a, b, point.index);
        const item = { id: uid("ann"), type: "channel", points: [a, b], offset: point.price - basePrice, color: lineColors[state.annotations.length % lineColors.length] };
        state.annotations.push(item);
        state.selected = { type: "annotation", id: item.id, part: "p2" };
        state.pending = null;
      }
      updateAll();
      return;
    }
    if (state.tool === "range") {
      if (!state.pending) {
        state.pending = { tool: "range", points: [point] };
      } else {
        const start = state.pending.points[0];
        const text = window.prompt("這段區間要寫什麼？", "");
        if (text === null) {
          state.pending = null;
          updateAll();
          return;
        }
        const range = {
          id: uid("range"),
          kind: "note",
          text: text.trim(),
          color: rangeColors.note,
          startIndex: start.index,
          endIndex: point.index,
          startTime: start.time,
          endTime: point.time,
        };
        state.ranges.push(range);
        state.selected = { type: "range", id: range.id, part: "body" };
        state.pending = null;
      }
      updateAll();
    }
  }

  function editRangeText(rangeId) {
    const range = state.ranges.find((item) => item.id === rangeId);
    if (!range) return;
    const nextText = window.prompt("編輯區間文字", range.text || labels[range.kind] || "");
    if (nextText === null) return;
    range.text = nextText.trim();
    range.kind = range.kind || "note";
    range.color = range.color || rangeColors.note;
    state.selected = { type: "range", id: range.id, part: "body" };
    updateAll();
  }

  function hitTest(pos) {
    const scale = state.lastScale;
    if (!scale) return null;
    for (const plan of [...state.tradePlans].reverse()) {
      for (const part of ["stop", "target"]) {
        const point = plan[part];
        if (!point) continue;
        const x = indexToX(point.index, scale);
        const y = priceToY(point.price, scale);
        const distance = part === "stop" || part === "target" ? Math.abs(pos.y - y) : Math.hypot(pos.x - x, pos.y - y);
        if (distance < 9) return { selected: { type: "trade", id: plan.id, part }, dragPart: part };
      }
    }
    for (const item of [...state.annotations].reverse()) {
      if (item.type === "hline") {
        if (Math.abs(pos.y - priceToY(item.price, scale)) < 8) return { selected: { type: "annotation", id: item.id, part: "body" }, dragPart: "body" };
      }
      if (item.type === "trend" || item.type === "extend") {
        const hit = hitLinePoints(item.points, pos, scale);
        if (hit) return { selected: { type: "annotation", id: item.id, part: hit }, dragPart: hit };
      }
      if (item.type === "channel") {
        const offsetPoints = item.points.map((p) => ({ ...p, price: p.price + item.offset }));
        const hit = hitLinePoints(item.points, pos, scale) || hitLinePoints(offsetPoints, pos, scale);
        if (hit) return { selected: { type: "annotation", id: item.id, part: hit }, dragPart: hit };
      }
    }
    for (const range of [...state.ranges].reverse()) {
      const start = Math.min(range.startIndex, range.endIndex);
      const end = Math.max(range.startIndex, range.endIndex);
      const x1 = indexToX(start, scale) - scale.barSpacing / 2;
      const x2 = indexToX(end, scale) + scale.barSpacing / 2;
      if (pos.y >= scale.priceTop && pos.y <= scale.priceBottom && pos.x >= x1 && pos.x <= x2) {
        const edge = Math.abs(pos.x - x1) < 8 ? "start" : Math.abs(pos.x - x2) < 8 ? "end" : "body";
        return { selected: { type: "range", id: range.id, part: edge }, dragPart: edge };
      }
    }
    return null;
  }

  function selectObjectsInRect(start, current) {
    const scale = state.lastScale;
    if (!scale) return [];
    const rect = normalizeRect(start, current);
    const items = [];
    state.annotations.forEach((item) => {
      if (item.type === "hline") {
        const y = priceToY(item.price, scale);
        if (y >= rect.y1 && y <= rect.y2) items.push({ type: "annotation", id: item.id, part: "body" });
      }
      if (item.type === "trend" || item.type === "extend" || item.type === "channel") {
        const points = [...(item.points || [])];
        if (item.type === "channel") {
          points.push(...item.points.map((p) => ({ ...p, price: p.price + item.offset })));
        }
        if (points.some((point) => pointInRect({ x: indexToX(point.index, scale), y: priceToY(point.price, scale) }, rect))) {
          items.push({ type: "annotation", id: item.id, part: "body" });
        }
      }
    });
    state.ranges.forEach((range) => {
      const startIndex = Math.min(range.startIndex, range.endIndex);
      const endIndex = Math.max(range.startIndex, range.endIndex);
      const x1 = indexToX(startIndex, scale) - scale.barSpacing / 2;
      const x2 = indexToX(endIndex, scale) + scale.barSpacing / 2;
      if (x2 >= rect.x1 && x1 <= rect.x2 && scale.priceBottom >= rect.y1 && scale.priceTop <= rect.y2) {
        items.push({ type: "range", id: range.id, part: "body" });
      }
    });
    state.tradePlans.forEach((plan) => {
      ["stop", "target"].forEach((part) => {
        const point = plan[part];
        if (!point) return;
        const screenPoint = { x: indexToX(point.index, scale), y: priceToY(point.price, scale) };
        if (pointInRect(screenPoint, rect)) items.push({ type: "trade", id: plan.id, part });
      });
    });
    return items;
  }

  function normalizeRect(a, b) {
    return {
      x1: Math.min(a.x, b.x),
      y1: Math.min(a.y, b.y),
      x2: Math.max(a.x, b.x),
      y2: Math.max(a.y, b.y),
    };
  }

  function pointInRect(point, rect) {
    return point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2;
  }

  function hitLinePoints(points, pos, scale) {
    const a = points[0];
    const b = points[1];
    const ax = indexToX(a.index, scale);
    const ay = priceToY(a.price, scale);
    const bx = indexToX(b.index, scale);
    const by = priceToY(b.price, scale);
    if (Math.hypot(pos.x - ax, pos.y - ay) < 9) return "p0";
    if (Math.hypot(pos.x - bx, pos.y - by) < 9) return "p1";
    return distanceToSegment(pos.x, pos.y, ax, ay, bx, by) < 8 ? "body" : null;
  }

  function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
    const t = clamp(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy), 0, 1);
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function startDrag(hit, point) {
    state.drag = {
      selected: hit.selected,
      part: hit.dragPart,
      startPoint: point,
      snapshot: JSON.parse(JSON.stringify({ annotations: state.annotations, ranges: state.ranges, tradePlans: state.tradePlans })),
    };
    state.selected = hit.selected;
  }

  function applyDrag(point) {
    if (!state.drag) return;
    const drag = state.drag;
    const deltaIndex = point.index - drag.startPoint.index;
    const deltaPrice = point.price - drag.startPoint.price;
    state.annotations = JSON.parse(JSON.stringify(drag.snapshot.annotations));
    state.ranges = JSON.parse(JSON.stringify(drag.snapshot.ranges));
    state.tradePlans = JSON.parse(JSON.stringify(drag.snapshot.tradePlans));
    if (drag.selected.type === "annotation") {
      const item = state.annotations.find((annotation) => annotation.id === drag.selected.id);
      if (!item) return;
      if (item.type === "hline") item.price = point.price;
      if (item.type === "trend" || item.type === "extend") movePoints(item.points, drag.part, deltaIndex, deltaPrice, point);
      if (item.type === "channel") {
        if (drag.part === "body") movePoints(item.points, "body", deltaIndex, deltaPrice, point);
        if (drag.part === "p0" || drag.part === "p1") movePoints(item.points, drag.part, deltaIndex, deltaPrice, point);
        if (drag.part === "p2") item.offset += deltaPrice;
      }
    }
    if (drag.selected.type === "range") {
      const item = state.ranges.find((range) => range.id === drag.selected.id);
      if (!item) return;
      if (drag.part === "start") item.startIndex = point.index;
      else if (drag.part === "end") item.endIndex = point.index;
      else {
        item.startIndex = clamp(item.startIndex + deltaIndex, 0, state.candles.length - 1);
        item.endIndex = clamp(item.endIndex + deltaIndex, 0, state.candles.length - 1);
      }
      item.startTime = state.candles[item.startIndex]?.time || item.startTime;
      item.endTime = state.candles[item.endIndex]?.time || item.endTime;
    }
    if (drag.selected.type === "trade") {
      const plan = state.tradePlans.find((item) => item.id === drag.selected.id);
      const frame = plan?.[drag.selected.part];
      if (frame) {
        frame.index = point.index;
        frame.time = point.time;
        frame.price = point.price;
      }
    }
    state.selected = drag.selected;
    updateAll();
  }

  function movePoints(points, part, deltaIndex, deltaPrice, point) {
    if (part === "body") {
      points.forEach((p) => {
        p.index = clamp(p.index + deltaIndex, 0, state.candles.length - 1);
        p.time = state.candles[p.index]?.time || p.time;
        p.price += deltaPrice;
      });
    } else {
      const idx = part === "p0" ? 0 : 1;
      points[idx].index = point.index;
      points[idx].time = point.time;
      points[idx].price = point.price;
    }
  }

  function deleteSelected() {
    if (!state.selected) return;
    const selected = state.selected;
    if (selected.type === "group") {
      selected.items.forEach((item) => deleteSelectionItem(item));
      state.selected = null;
      updateAll();
      return;
    }
    deleteSelectionItem(selected);
    state.selected = null;
    updateAll();
  }

  function deleteSelectionItem(selected) {
    if (selected.type === "annotation") state.annotations = state.annotations.filter((item) => item.id !== selected.id);
    if (selected.type === "range") state.ranges = state.ranges.filter((item) => item.id !== selected.id);
    if (selected.type === "trade") {
      const plan = state.tradePlans.find((item) => item.id === selected.id);
      if (plan) plan[selected.part] = null;
    }
  }

  async function startRandomPractice() {
    try {
      stopPlayback();
      setBusy("抽題中（讀取離線資料）");
      const params = new URLSearchParams({ timeframe: state.timeframe, minBars: "50", symbol: state.symbol || "" });
      const item = await api(`/api/random-session?${params.toString()}`);
      state.symbol = item.symbol;
      state.tradeDate = item.date;
      setTimeframe(item.timeframe);
      els.symbolSelect.value = state.symbol;
      await loadDates(false);
      els.dateSelect.value = state.tradeDate;
      await loadCandles({ startIndex: item.startIndex });
      showToast(`抽到 ${item.symbol} ${item.date}`);
    } catch (error) {
      showToast(error.message);
      setBusy("抽題失敗");
    }
  }

  async function saveSession() {
    const stats = portfolioStats();
    const payload = {
      symbol: state.symbol,
      tradeDate: state.tradeDate,
      timeframe: state.timeframe,
      startIndex: state.openingIndex,
      endIndex: state.replayIndex,
      result: `交易計劃 ${state.tradePlans.length} 組，總損益 ${formatMoney(stats.total)}`,
      score: null,
      notes: state.tradePlans.map((plan) => plan.notes).filter(Boolean).join("\n"),
      annotations: state.annotations,
      ranges: state.ranges,
      tradePlans: state.tradePlans,
      indicators: indicatorPayload(),
      metrics: { portfolio: stats },
    };
    try {
      await api("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      showToast("練習已儲存");
      await loadSessions();
    } catch (error) {
      showToast(error.message);
    }
  }

  function indicatorPayload() {
    return {
      smas: state.indicators.smas,
      volume: els.volumeToggle.checked,
      vwap: els.vwapToggle.checked,
      macd: els.macdToggle.checked,
      kd: els.kdToggle.checked,
      rsi: els.rsiToggle.checked,
      cci: els.cciToggle.checked,
      order: state.indicatorOrder,
      paneHeights: state.paneHeights,
    };
  }

  async function loadSessions() {
    const data = await api("/api/sessions?limit=30");
    state.sessions = data.sessions || [];
    els.historyCount.textContent = String(state.sessions.length);
    if (!state.sessions.length) {
      els.historyList.innerHTML = `<div class="history-meta">還沒有練習紀錄。</div>`;
      return;
    }
    els.historyList.innerHTML = state.sessions
      .map((session) => {
        const created = new Date(session.createdAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        const plans = session.tradePlans?.length || 0;
        return `<article class="history-item">
          <div class="history-top"><span class="history-symbol">${escapeHtml(session.symbol)} ${escapeHtml(session.timeframe)}</span><span class="score-pill">${plans} 策略</span></div>
          <div class="history-meta">${escapeHtml(session.tradeDate)} · ${created}</div>
          <div class="history-note">${escapeHtml(session.result || session.notes || "")}</div>
          <div class="history-actions">
            <button data-session-id="${session.id}">載入</button>
            <button class="danger" data-session-delete="${session.id}">刪除</button>
          </div>
        </article>`;
      })
      .join("");
  }

  async function deleteSession(sessionId) {
    try {
      await api(`/api/sessions?id=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      state.sessions = state.sessions.filter((item) => String(item.id) !== String(sessionId));
      showToast("練習紀錄已刪除");
      await loadSessions();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function loadSessionIntoChart(sessionId) {
    const session = state.sessions.find((item) => String(item.id) === String(sessionId));
    if (!session) return;
    try {
      stopPlayback();
      state.symbol = session.symbol;
      state.tradeDate = session.tradeDate;
      setTimeframe(session.timeframe);
      els.symbolSelect.value = state.symbol;
      await loadDates(false);
      els.dateSelect.value = state.tradeDate;
      await loadCandles({ startIndex: session.endIndex ?? session.startIndex ?? 0 });
      state.annotations = session.annotations || [];
      state.ranges = session.ranges || [];
      state.tradePlans = session.tradePlans?.length ? session.tradePlans : state.tradePlans;
      state.activePlanId = state.tradePlans[0]?.id || null;
      if (session.indicators?.smas) state.indicators.smas = session.indicators.smas;
      if (Array.isArray(session.indicators?.order)) state.indicatorOrder = session.indicators.order;
      if (session.indicators?.paneHeights) state.paneHeights = { ...state.paneHeights, ...session.indicators.paneHeights };
      els.volumeToggle.checked = session.indicators?.volume ?? els.volumeToggle.checked;
      els.vwapToggle.checked = session.indicators?.vwap ?? els.vwapToggle.checked;
      els.macdToggle.checked = Boolean(session.indicators?.macd);
      els.kdToggle.checked = Boolean(session.indicators?.kd);
      els.rsiToggle.checked = Boolean(session.indicators?.rsi);
      els.cciToggle.checked = Boolean(session.indicators?.cci);
      updateAll();
      showToast("已載入練習紀錄");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function generateCoachAdvice(profile = "quick") {
    const scale = state.lastScale;
    if (!scale) return;
    const profileLabels = {
      quick: "快速 · GPT-5.4 mini",
      standard: "標準 · GPT-5.4",
      deep: "深度 · GPT-5.5",
    };
    const visibleCandles = state.candles.slice(scale.start, scale.end).map((candle, offset) => ({
      index: scale.start + offset,
      time: candle.time,
      timeNY: formatTime(candle.time, true),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));
    els.coachButtons.forEach((button) => {
      button.disabled = true;
      button.classList.toggle("active", button.dataset.coachMode === profile);
    });
    els.coachOutput.innerHTML = `<div class="coach-loading">${escapeHtml(profileLabels[profile] || "教練")} 產生中...</div>`;
    try {
      const data = await api("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile,
          symbol: state.symbol,
          tradeDate: state.tradeDate,
          timeframe: state.timeframe,
          replayIndex: state.replayIndex,
          visibleRange: { start: scale.start, end: scale.end },
          candles: visibleCandles,
          annotations: state.annotations,
          ranges: state.ranges,
          tradePlans: state.tradePlans,
          indicators: indicatorPayload(),
          stats: portfolioStats(),
        }),
      });
      renderCoachOutput(data.profileLabel || profileLabels[profile], data.model, data.advice, data.incomplete);
    } catch (error) {
      els.coachOutput.innerHTML = `<div class="coach-error">${escapeHtml(error.message)}</div>`;
    } finally {
      els.coachButtons.forEach((button) => {
        button.disabled = false;
        button.classList.remove("active");
      });
    }
  }

  function renderCoachOutput(title, model, text, incomplete = false) {
    els.coachOutput.innerHTML = `
      <div class="coach-answer-head">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(model)}</span>
      </div>
      <div class="coach-answer-body">${markdownLiteToHtml(text)}</div>
      ${incomplete ? `<div class="coach-warning">這次回覆可能被模型輸出上限截斷，請再按一次或改用更高深度。</div>` : ""}
    `;
  }

  function markdownLiteToHtml(text) {
    const lines = String(text || "").split(/\r?\n/);
    const html = [];
    let listOpen = false;
    const closeList = () => {
      if (listOpen) {
        html.push("</ul>");
        listOpen = false;
      }
    };
    lines.forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line) {
        closeList();
        return;
      }
      const headingMatch = line.match(/^\*\*(.+)\*\*$/) || line.match(/^#{1,4}\s+(.+)$/);
      const numberedMatch = line.match(/^(\d+)\.\s+\*\*(.+?)\*\*\s*$/) || line.match(/^(\d+)\.\s+(.+)$/);
      const bulletMatch = line.match(/^[-•]\s+(.+)$/);
      if (numberedMatch) {
        closeList();
        html.push(`<h4>${escapeHtml(numberedMatch[1])}. ${inlineMarkdown(numberedMatch[2])}</h4>`);
      } else if (headingMatch) {
        closeList();
        html.push(`<h3>${inlineMarkdown(headingMatch[1])}</h3>`);
      } else if (bulletMatch) {
        if (!listOpen) {
          html.push("<ul>");
          listOpen = true;
        }
        html.push(`<li>${inlineMarkdown(bulletMatch[1])}</li>`);
      } else {
        closeList();
        html.push(`<p>${inlineMarkdown(line)}</p>`);
      }
    });
    closeList();
    return html.join("");
  }

  function inlineMarkdown(text) {
    return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function handleControlPointer(event) {
    if (event.type === "click" && event.detail !== 0) return;

    const planAction = closestTarget(event, "[data-plan-action]");
    if (planAction) {
      stopControlEvent(event);
      const [planId, action] = planAction.dataset.planAction.split(":");
      setTradeAction(action, planId);
      return;
    }

    const planOrder = closestTarget(event, "[data-plan-order]");
    if (planOrder) {
      stopControlEvent(event);
      const [planId, order] = planOrder.dataset.planOrder.split(":");
      applyPlanOrder(planId, order);
      return;
    }

    const frameDelete = closestTarget(event, "[data-frame-delete]");
    if (frameDelete) {
      stopControlEvent(event);
      const [planId, part] = frameDelete.dataset.frameDelete.split(":");
      deletePlanFrame(planId, part);
      return;
    }

    const planDelete = closestTarget(event, "[data-plan-delete]");
    if (planDelete) {
      stopControlEvent(event);
      deletePlan(planDelete.dataset.planDelete);
      return;
    }

    const smaDelete = closestTarget(event, "[data-sma-delete]");
    if (smaDelete) {
      stopControlEvent(event);
      deleteSma(smaDelete.dataset.smaDelete);
      return;
    }

    const colorPick = closestTarget(event, "[data-sma-color-pick]");
    if (colorPick) {
      stopControlEvent(event);
      const [smaId, color] = colorPick.dataset.smaColorPick.split(":");
      setSmaColor(smaId, color);
      return;
    }

    const indicatorMove = closestTarget(event, "[data-indicator-move]");
    if (indicatorMove) {
      stopControlEvent(event);
      const [name, direction] = indicatorMove.dataset.indicatorMove.split(":");
      moveIndicatorPane(name, direction);
      return;
    }

    const smaToggle = closestTarget(event, "[data-sma-toggle], [data-sma-visible]");
    if (smaToggle && !closestTarget(event, "[data-sma-color], [data-sma-delete], [data-sma-color-pick]")) {
      stopControlEvent(event);
      toggleSma(smaToggle.dataset.smaToggle || smaToggle.dataset.smaVisible);
    }
  }

  function handleControlInput(event) {
    const qtyInput = closestTarget(event, "[data-plan-qty]");
    if (qtyInput) {
      syncPlanQty(qtyInput.dataset.planQty, qtyInput.value);
      return;
    }

    const notesInput = closestTarget(event, "[data-plan-notes]");
    if (notesInput) {
      syncPlanNotes(notesInput.dataset.planNotes, notesInput.value);
      return;
    }

    const smaColor = closestTarget(event, "[data-sma-color]");
    if (smaColor) setSmaColor(smaColor.dataset.smaColor, smaColor.value, true);

    const paneHeight = closestTarget(event, "[data-pane-height]");
    if (paneHeight) setPaneHeight(paneHeight.dataset.paneHeight, paneHeight.value);
  }

  function handleControlChange(event) {
    const qtyInput = closestTarget(event, "[data-plan-qty]");
    if (qtyInput) {
      syncPlanQty(qtyInput.dataset.planQty, qtyInput.value);
      return;
    }

    const notesInput = closestTarget(event, "[data-plan-notes]");
    if (notesInput) {
      syncPlanNotes(notesInput.dataset.planNotes, notesInput.value);
      return;
    }

    const smaColor = closestTarget(event, "[data-sma-color]");
    if (smaColor) setSmaColor(smaColor.dataset.smaColor, smaColor.value);

    const paneHeight = closestTarget(event, "[data-pane-height]");
    if (paneHeight) setPaneHeight(paneHeight.dataset.paneHeight, paneHeight.value);
  }

  function bindEvents() {
    if (OFFLINE_MODE && els.openaiKeyInput) {
      els.openaiKeyInput.value = localStorage.getItem(OFFLINE_OPENAI_KEY) || "";
      els.saveOpenaiKeyBtn?.addEventListener("click", () => {
        localStorage.setItem(OFFLINE_OPENAI_KEY, els.openaiKeyInput.value.trim());
        showToast("OpenAI API Key 已儲存在此裝置");
      });
      els.clearOpenaiKeyBtn?.addEventListener("click", () => {
        localStorage.removeItem(OFFLINE_OPENAI_KEY);
        els.openaiKeyInput.value = "";
        showToast("OpenAI API Key 已清除");
      });
    }
    document.addEventListener("pointerdown", handleControlPointer, true);
    document.addEventListener("click", handleControlPointer, true);
    document.addEventListener("input", handleControlInput, true);
    document.addEventListener("change", handleControlChange, true);

    els.symbolSelect.addEventListener("change", async () => {
      state.symbol = els.symbolSelect.value;
      try {
        await loadDates(true);
        await loadCandles();
      } catch (error) {
        showToast(error.message);
      }
    });
    els.dateSelect.addEventListener("change", async () => {
      state.tradeDate = els.dateSelect.value;
      try {
        await loadCandles();
      } catch (error) {
        showToast(error.message);
      }
    });
    els.timeframeGroup.addEventListener("click", async (event) => {
      const button = closestTarget(event, "button[data-timeframe]");
      if (!button) return;
      setTimeframe(button.dataset.timeframe);
      try {
        await loadCandles();
      } catch (error) {
        showToast(error.message);
      }
    });
    els.customTimeframeBtn.addEventListener("click", applyCustomTimeframe);
    els.customTimeframeValue.addEventListener("keydown", (event) => {
      if (event.key === "Enter") applyCustomTimeframe();
    });
    els.randomBtn.addEventListener("click", startRandomPractice);
    els.resetBtn.addEventListener("click", () => setReplayIndex(state.openingIndex, true));
    els.stepBackBtn.addEventListener("click", () => {
      stopPlayback();
      setReplayIndex(state.replayIndex - 1, true);
    });
    els.stepForwardBtn.addEventListener("click", () => {
      stopPlayback();
      setReplayIndex(state.replayIndex + 1, true);
    });
    els.fullViewBtn.addEventListener("click", () => {
      stopPlayback();
      setReplayIndex(state.candles.length - 1, true);
    });
    els.playBtn.addEventListener("click", () => {
      if (state.playing) {
        stopPlayback();
        return;
      }
      state.playing = true;
      els.playBtn.textContent = "Ⅱ";
      state.playTimer = window.setInterval(() => {
        if (state.replayIndex >= state.candles.length - 1) stopPlayback();
        else setReplayIndex(state.replayIndex + 1, true);
      }, Number(els.speedSelect.value));
    });
    els.speedSelect.addEventListener("change", () => {
      if (state.playing) {
        stopPlayback();
        els.playBtn.click();
      }
    });
    els.replaySlider.addEventListener("input", () => {
      stopPlayback();
      setReplayIndex(Number(els.replaySlider.value), true);
    });

    document.querySelectorAll(".tool[data-tool]").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
    els.magnetToggleBtn.addEventListener("click", () => {
      state.snapToCandle = !state.snapToCandle;
      els.magnetToggleBtn.classList.toggle("active", state.snapToCandle);
      showToast(state.snapToCandle ? "磁鐵吸附已開啟" : "磁鐵吸附已關閉");
    });
    els.deleteSelectedBtn.addEventListener("click", deleteSelected);
    els.clearBtn.addEventListener("click", () => {
      state.annotations = [];
      state.ranges = [];
      state.selected = null;
      state.pending = null;
      updateAll();
    });

    els.newPlanBtn.addEventListener("click", () => createPlan(true));
    els.planList.addEventListener("pointerdown", (event) => {
      const card = closestTarget(event, "[data-plan-id]");
      if (!card || closestTarget(event, "[data-plan-delete]")) return;
      state.activePlanId = card.dataset.planId;
      els.planList.querySelectorAll(".plan-card").forEach((item) => {
        item.classList.toggle("active", item.dataset.planId === state.activePlanId);
      });
    });
    els.planList.addEventListener("click", (event) => {
      const card = closestTarget(event, "[data-plan-id]");
      const actionButton = closestTarget(event, "[data-plan-action]");
      const orderButton = closestTarget(event, "[data-plan-order]");
      const deleteButton = closestTarget(event, "[data-plan-delete]");
      const frameDeleteButton = closestTarget(event, "[data-frame-delete]");
      if (actionButton) {
        event.preventDefault();
        event.stopPropagation();
        const [planId, action] = actionButton.dataset.planAction.split(":");
        setTradeAction(action, planId);
        return;
      }
      if (orderButton) {
        event.preventDefault();
        event.stopPropagation();
        const [planId, order] = orderButton.dataset.planOrder.split(":");
        applyPlanOrder(planId, order);
        return;
      }
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        state.tradePlans = state.tradePlans.filter((plan) => plan.id !== deleteButton.dataset.planDelete);
        state.activePlanId = state.tradePlans[0]?.id || null;
        state.selected = null;
        if (!state.tradePlans.length) createPlan(false);
        updateAll();
        return;
      }
      if (frameDeleteButton) {
        event.preventDefault();
        event.stopPropagation();
        const [planId, part] = frameDeleteButton.dataset.frameDelete.split(":");
        const plan = state.tradePlans.find((item) => item.id === planId);
        if (plan && part) plan[part] = null;
        if (state.selected?.type === "trade" && state.selected.id === planId && state.selected.part === part) {
          state.selected = null;
        }
        updateAll();
        return;
      }
      if (card && !closestTarget(event, "button, input, textarea, select")) {
        state.activePlanId = card.dataset.planId;
        updateAll();
      }
    });
    els.planList.addEventListener("input", (event) => {
      const qtyInput = closestTarget(event, "[data-plan-qty]");
      const notesInput = closestTarget(event, "[data-plan-notes]");
      if (qtyInput) {
        const plan = state.tradePlans.find((item) => item.id === qtyInput.dataset.planQty);
        if (!plan) return;
        plan.qty = Math.max(1, Math.round(Number(qtyInput.value) || 1));
        if (state.tradeAction?.planId === plan.id) state.tradeAction.qty = plan.qty;
        return;
      }
      if (notesInput) {
        const plan = state.tradePlans.find((item) => item.id === notesInput.dataset.planNotes);
        if (plan) plan.notes = notesInput.value;
      }
    });
    els.planList.addEventListener("focusin", (event) => {
      const card = closestTarget(event, "[data-plan-id]");
      if (!card) return;
      state.activePlanId = card.dataset.planId;
      els.planList.querySelectorAll(".plan-card").forEach((item) => {
        item.classList.toggle("active", item.dataset.planId === state.activePlanId);
      });
    });

    els.addSmaBtn.addEventListener("click", () => {
      const period = clamp(Math.round(numberFrom(els.smaPeriodInput, 20)), 2, 500);
      state.indicators.smas.push({ id: uid("sma"), period, color: lineColors[state.indicators.smas.length % lineColors.length], visible: true });
      updateAll();
    });
    els.smaList.addEventListener("click", (event) => {
      const del = closestTarget(event, "[data-sma-delete]");
      if (del) {
        event.preventDefault();
        event.stopPropagation();
        state.indicators.smas = state.indicators.smas.filter((sma) => sma.id !== del.dataset.smaDelete);
        updateAll();
      }
    });
    els.smaList.addEventListener("change", (event) => {
      const visible = closestTarget(event, "[data-sma-visible]");
      const color = closestTarget(event, "[data-sma-color]");
      if (visible) {
        const item = state.indicators.smas.find((sma) => sma.id === visible.dataset.smaVisible);
        if (item) item.visible = visible.checked;
        updateAll();
      }
      if (color) {
        const item = state.indicators.smas.find((sma) => sma.id === color.dataset.smaColor);
        if (item) item.color = color.value;
        updateAll();
      }
    });
    els.smaList.addEventListener("input", (event) => {
      const color = closestTarget(event, "[data-sma-color]");
      if (!color) return;
      const item = state.indicators.smas.find((sma) => sma.id === color.dataset.smaColor);
      if (!item) return;
      item.color = color.value;
      color.closest(".pill")?.style.setProperty("--pill-color", color.value);
      draw();
    });
    [els.volumeToggle, els.vwapToggle, els.macdToggle, els.kdToggle, els.rsiToggle, els.cciToggle].forEach((input) => input.addEventListener("change", draw));

    els.saveSessionBtn.addEventListener("click", saveSession);
    els.coachButtons.forEach((button) => {
      button.addEventListener("click", () => generateCoachAdvice(button.dataset.coachMode));
    });
    els.historyList.addEventListener("click", (event) => {
      const deleteButton = closestTarget(event, "button[data-session-delete]");
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        deleteSession(deleteButton.dataset.sessionDelete);
        return;
      }
      const button = closestTarget(event, "button[data-session-id]");
      if (button) loadSessionIntoChart(button.dataset.sessionId);
    });

    els.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const pos = eventPosition(event);
      const scale = state.lastScale;
      const oldBars = clamp(Math.round(state.barsPerScreen), 24, 520);
      const oldStart = scale?.start ?? Math.max(0, (state.viewEnd || revealEnd()) - oldBars);
      const anchorIndex = scale ? clamp(scale.start + (pos.x - scale.plotLeft) / scale.barSpacing - 0.5, 0, revealEnd() - 1) : state.replayIndex;
      const anchorRatio = clamp((anchorIndex - oldStart) / Math.max(1, oldBars), 0, 1);
      const newBars = clamp(state.barsPerScreen * (event.deltaY < 0 ? 0.84 : 1.18), 24, 520);
      const maxEnd = Math.max(1, revealEnd());
      let newStart = anchorIndex - anchorRatio * newBars;
      let newEnd = newStart + newBars;
      if (newEnd > maxEnd) {
        newEnd = maxEnd;
        newStart = newEnd - newBars;
      }
      if (newStart < 0) {
        newStart = 0;
        newEnd = Math.min(maxEnd, newBars);
      }
      state.barsPerScreen = newBars;
      state.viewEnd = clamp(newEnd, 1, maxEnd);
      draw();
    }, { passive: false });
    els.canvas.addEventListener("dblclick", (event) => {
      const pos = eventPosition(event);
      if (isPriceAxisPosition(pos)) {
        state.priceZoom = 1;
        state.pricePan = 0;
        draw();
        return;
      }
      const hit = hitTest(pos);
      if (hit?.selected?.type === "range") editRangeText(hit.selected.id);
    });
    els.canvas.addEventListener("pointerdown", (event) => {
      const pos = eventPosition(event);
      const paneDivider = paneDividerAt(pos);
      if (paneDivider) {
        state.paneResize = { name: paneDivider, y: pos.y, height: state.paneHeights[paneDivider] || 76 };
        state.pointer = null;
        state.drag = null;
        els.canvas.style.cursor = "ns-resize";
        return;
      }
      if (isPriceAxisPosition(pos)) {
        state.axisDrag = { y: pos.y, priceZoom: state.priceZoom || 1, pricePan: state.pricePan || 0 };
        state.pointer = null;
        state.drag = null;
        els.canvas.style.cursor = "ns-resize";
        return;
      }
      const point = chartPointFromPosition(pos);
      if (state.tool === "boxselect") {
        state.selectionBox = { start: pos, current: pos };
        state.pointer = { x: pos.x, y: pos.y, viewEnd: state.viewEnd, pricePan: state.pricePan || 0, moved: false, hit: null };
        draw();
        return;
      }
      const hit = state.tool === "cursor" && !state.tradeAction ? hitTest(pos) : null;
      state.pointer = { x: pos.x, y: pos.y, viewEnd: state.viewEnd, pricePan: state.pricePan || 0, moved: false, hit };
      if (hit && point) startDrag(hit, point);
      else if (state.tool === "cursor" && !state.tradeAction) els.canvas.style.cursor = "grabbing";
    });
    window.addEventListener("pointermove", (event) => {
      const pos = eventPosition(event);
      if (state.paneResize && event.buttons) {
        const dy = pos.y - state.paneResize.y;
        setPaneHeight(state.paneResize.name, state.paneResize.height + dy);
        els.canvas.style.cursor = "ns-resize";
        return;
      }
      if (state.axisDrag && event.buttons) {
        const dy = pos.y - state.axisDrag.y;
        state.priceZoom = clamp(state.axisDrag.priceZoom * Math.exp(-dy / 140), 0.25, 10);
        els.canvas.style.cursor = "ns-resize";
        draw();
        return;
      }
      const point = chartPointFromPosition(pos);
      state.crosshair = pos;
      state.hoverPoint = point;
      updateTooltip(pos);
      if (state.selectionBox && event.buttons) {
        state.selectionBox.current = pos;
        if (state.pointer) state.pointer.moved = true;
        draw();
        return;
      }
      if (state.drag && point && event.buttons) {
        state.pointer.moved = true;
        applyDrag(point);
        return;
      }
      if (state.pointer && !state.drag && state.tool === "cursor" && event.buttons) {
        const dx = pos.x - state.pointer.x;
        const dy = pos.y - state.pointer.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) state.pointer.moved = true;
        const scale = state.lastScale;
        if (scale) {
          const maxEnd = Math.max(1, revealEnd());
          const minEnd = Math.min(maxEnd, Math.round(state.barsPerScreen));
          state.viewEnd = clamp(state.pointer.viewEnd - dx / scale.barSpacing, minEnd, maxEnd);
          const pricePerPixel = (scale.maxPrice - scale.minPrice) / (scale.priceHeight || 1);
          state.pricePan = state.pointer.pricePan + dy * pricePerPixel;
        }
      }
      draw();
    });
    window.addEventListener("pointerup", (event) => {
      const pos = eventPosition(event);
      if (state.paneResize) {
        state.paneResize = null;
        els.canvas.style.cursor = "crosshair";
        updateAll();
        return;
      }
      if (state.axisDrag) {
        state.axisDrag = null;
        els.canvas.style.cursor = "crosshair";
        updateAll();
        return;
      }
      if (state.selectionBox) {
        state.selectionBox.current = pos;
        const items = selectObjectsInRect(state.selectionBox.start, state.selectionBox.current);
        state.selected = items.length ? { type: "group", items } : null;
        state.selectionBox = null;
        state.pointer = null;
        state.drag = null;
        updateAll();
        return;
      }
      if (state.pointer && !state.drag && !state.pointer.moved) handleChartClick(pos);
      state.pointer = null;
      state.drag = null;
      els.canvas.style.cursor = "crosshair";
      updateAll();
    });
    els.canvas.addEventListener("mouseleave", () => {
      state.crosshair = null;
      state.axisDrag = null;
      state.paneResize = null;
      els.tooltip.classList.add("hidden");
      renderOhlc(currentCandle());
      draw();
    });
    window.addEventListener("keydown", (event) => {
      if (event.target.matches("input, textarea, select")) return;
      if (event.code === "Space") {
        event.preventDefault();
        els.playBtn.click();
      }
      if (event.code === "ArrowRight") els.stepForwardBtn.click();
      if (event.code === "ArrowLeft") els.stepBackBtn.click();
      if (event.key === "Delete" || event.key === "Backspace") deleteSelected();
      if (event.key.toLowerCase() === "h") setTool("hline");
      if (event.key.toLowerCase() === "t") setTool("trend");
      if (event.key.toLowerCase() === "r") setTool("range");
    });
  }

  async function init() {
    bindEvents();
    new ResizeObserver(draw).observe(els.chartShell);
    try {
      await loadSymbols();
      await loadDates(true);
      await loadCandles();
      await loadSessions();
    } catch (error) {
      setBusy("初始化失敗");
      showToast(error.message);
      draw();
    }
  }

  init();
})();
