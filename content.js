(() => {
  "use strict";

  // Guard against double-injection (declared content script + on-demand inject).
  if (window.__ytsLoaded) return;
  window.__ytsLoaded = true;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    open: false, // panel vs. ribbon (persisted)
    showTimes: true, // timestamp column visibility (persisted)
    autoScroll: true, // follow the playing line (persisted)
    tab: "transcript", // transcript | summary | chapters
    query: "",
    videoId: null,
    segments: [], // [{ start, dur, text }]
    languages: [], // [{ code, label, kind, baseUrl }]
    language: null, // selected language code
    status: "idle", // idle | extracting | ready | none
    activeIndex: -1,
  };

  let host = null;
  let shadow = null;
  let els = {};
  let rowEls = [];
  let video = null;
  let toastTimer = null;

  const log = (...a) => console.debug("[Transcript Sidebar]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function getVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname === "/watch") return url.searchParams.get("v");
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || null;
    } catch (_) {}
    return null;
  }

  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const s = seconds % 60;
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function srtTime(seconds) {
    seconds = Math.max(0, seconds || 0);
    const ms = Math.floor((seconds % 1) * 1000);
    const s = Math.floor(seconds) % 60;
    const m = Math.floor(seconds / 60) % 60;
    const h = Math.floor(seconds / 3600);
    const pad = (n, l = 2) => String(n).padStart(l, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  }

  function totalDuration() {
    if (!state.segments.length) return 0;
    const last = state.segments[state.segments.length - 1];
    return last.start + (last.dur || 0);
  }

  function decodeEntities(str) {
    const ta = document.createElement("textarea");
    ta.innerHTML = str;
    return ta.value;
  }

  // Balanced {...}/[...] extraction that respects strings — robust against the
  // deeply-nested blobs YouTube embeds in the page.
  function extractBalancedAfter(text, key, open, close) {
    const keyIdx = text.indexOf(key);
    if (keyIdx === -1) return null;
    const start = text.indexOf(open, keyIdx);
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function parseJsonAfter(text, key, open, close) {
    const blob = extractBalancedAfter(text, key, open, close);
    if (!blob) return null;
    try {
      return JSON.parse(blob);
    } catch (_) {
      return null;
    }
  }

  function deepCollect(obj, key, out) {
    if (!obj || typeof obj !== "object") return out;
    if (Array.isArray(obj)) {
      for (const item of obj) deepCollect(item, key, out);
      return out;
    }
    for (const k of Object.keys(obj)) {
      if (k === key) out.push(obj[k]);
      deepCollect(obj[k], key, out);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Transcript extraction (multiple strategies for resilience)
  // ---------------------------------------------------------------------------
  async function fetchWatchHtml(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error(`watch page HTTP ${res.status}`);
    return res.text();
  }

  function trackLabel(t) {
    const name =
      (t.name && (t.name.simpleText ||
        (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || "";
    if (name) return name;
    const base = (t.languageCode || "Unknown").toUpperCase();
    return t.kind === "asr" ? `${base} (auto)` : base;
  }

  function parseCaptionLanguages(html) {
    const tracks = parseJsonAfter(html, '"captionTracks"', "[", "]") || [];
    return tracks.map((t) => ({
      code: t.languageCode,
      kind: t.kind,
      label: trackLabel(t),
      baseUrl: t.baseUrl || t.baseURL || "",
    }));
  }

  function pickLanguage(langs) {
    if (!langs.length) return null;
    const isEn = (l) => (l.code || "").toLowerCase().startsWith("en");
    return (
      langs.find((l) => isEn(l) && l.kind !== "asr") ||
      langs.find((l) => isEn(l)) ||
      langs.find((l) => l.kind !== "asr") ||
      langs[0]
    );
  }

  function parseJson3(data) {
    const out = [];
    for (const event of data.events || []) {
      if (!event.segs) continue;
      const text = event.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (!text) continue;
      out.push({ start: (event.tStartMs || 0) / 1000, dur: (event.dDurationMs || 0) / 1000, text });
    }
    return out;
  }

  function parseXmlCaptions(xml) {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const out = [];
    doc.querySelectorAll("text").forEach((node) => {
      const text = decodeEntities(node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      out.push({
        start: parseFloat(node.getAttribute("start") || "0"),
        dur: parseFloat(node.getAttribute("dur") || "0"),
        text,
      });
    });
    return out;
  }

  // Strategy A: the caption track's timedtext URL (json3 → XML).
  async function fetchTimedText(baseUrl) {
    if (!baseUrl) return [];
    try {
      const res = await fetch(baseUrl + "&fmt=json3", { credentials: "include" });
      const body = (await res.text()).trim();
      if (body) {
        const segs = parseJson3(JSON.parse(body));
        if (segs.length) return segs;
      }
    } catch (err) {
      log("timedtext json3 failed", err);
    }
    try {
      const res = await fetch(baseUrl, { credentials: "include" });
      const xml = (await res.text()).trim();
      if (xml) return parseXmlCaptions(xml);
    } catch (err) {
      log("timedtext xml failed", err);
    }
    return [];
  }

  // Strategy B: YouTube's get_transcript InnerTube API (default language).
  async function fetchViaGetTranscript(videoId, html) {
    if (!html) html = await fetchWatchHtml(videoId);
    const initialData = parseJsonAfter(html, "ytInitialData", "{", "}");
    const endpoints = initialData ? deepCollect(initialData, "getTranscriptEndpoint", []) : [];
    const params = endpoints.find((e) => e && e.params) && endpoints.find((e) => e && e.params).params;
    if (!params) return [];
    const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
    const context = parseJsonAfter(html, '"INNERTUBE_CONTEXT":', "{", "}");
    if (!apiKey || !context) return [];
    const res = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context, params }),
    });
    if (!res.ok) throw new Error(`get_transcript HTTP ${res.status}`);
    const data = await res.json();
    const renderers = deepCollect(data, "transcriptSegmentRenderer", []);
    const out = [];
    for (const r of renderers) {
      const snip = r.snippet || {};
      const raw = snip.runs ? snip.runs.map((x) => x.text || "").join("") : snip.simpleText || "";
      const text = raw.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const startMs = parseInt(r.startMs || "0", 10);
      const endMs = parseInt(r.endMs || "0", 10);
      out.push({ start: startMs / 1000, dur: (endMs - startMs) / 1000, text });
    }
    return out;
  }

  // Strategy C: scrape YouTube's own rendered transcript panel.
  function readRenderedSegments() {
    const out = [];
    document.querySelectorAll("ytd-transcript-segment-renderer").forEach((node) => {
      const tx = node.querySelector(".segment-text");
      if (!tx) return;
      const text = (tx.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      const ts = node.querySelector(".segment-timestamp");
      const parts = ((ts && ts.textContent) || "0").trim().split(":").map(Number);
      const start = parts.some(isNaN) ? 0 : parts.reduce((a, n) => a * 60 + n, 0);
      out.push({ start, dur: 0, text });
    });
    return out;
  }

  async function scrapeTranscriptFromPanel(videoId) {
    if (getVideoId() !== videoId) return [];
    let segs = readRenderedSegments();
    if (segs.length) return segs;

    const expand = document.querySelector("#description #expand, tp-yt-paper-button#expand");
    if (expand) { expand.click(); await sleep(350); }

    const btn =
      document.querySelector('ytd-video-description-transcript-section-renderer button, button[aria-label*="transcript" i]') ||
      [...document.querySelectorAll("ytd-button-renderer, tp-yt-paper-button, button")].find((c) =>
        ["show transcript", "transcript"].includes((c.textContent || "").trim().toLowerCase())
      );
    if (!btn) return [];
    btn.click();

    for (let i = 0; i < 24 && !segs.length; i++) {
      await sleep(250);
      segs = readRenderedSegments();
    }
    if (segs.length) {
      const panel = document.querySelector(
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
      );
      const close = panel && panel.querySelector('button[aria-label="Close" i], ytd-engagement-panel-title-header-renderer button');
      if (close) close.click();
    }
    return segs;
  }

  async function extract(videoId, preferredLang) {
    let html = null;
    try { html = await fetchWatchHtml(videoId); } catch (err) { log("watch html failed", err); }

    const languages = html ? parseCaptionLanguages(html) : [];
    let chosen = null;
    if (preferredLang) chosen = languages.find((l) => l.code === preferredLang);
    if (!chosen) chosen = pickLanguage(languages);

    let segments = [];
    if (chosen && chosen.baseUrl) {
      segments = await fetchTimedText(chosen.baseUrl);
      if (segments.length) log("extracted via timedtext", chosen.code);
    }
    if (!segments.length) {
      try {
        segments = await fetchViaGetTranscript(videoId, html);
        if (segments.length) log("extracted via get_transcript");
      } catch (err) { log("get_transcript failed", err); }
    }
    if (!segments.length) {
      segments = await scrapeTranscriptFromPanel(videoId);
      if (segments.length) log("extracted via panel scrape");
    }

    return { segments, languages, language: chosen ? chosen.code : null };
  }

  async function loadTranscript(videoId, preferredLang) {
    state.status = "extracting";
    state.activeIndex = -1;
    renderStatus();
    renderList();

    try {
      const { segments, languages, language } = await extract(videoId, preferredLang);
      // Bail if the user navigated away mid-fetch.
      if (videoId !== state.videoId) return;
      state.segments = segments;
      state.languages = languages;
      state.language = language;
      state.status = segments.length ? "ready" : "none";
    } catch (err) {
      log("loadTranscript error", err);
      state.status = "none";
      state.segments = [];
    }
    renderLanguages();
    renderStatus();
    renderList();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------
  function persist() {
    try {
      chrome.storage.local.set({
        open: state.open,
        showTimes: state.showTimes,
        autoScroll: state.autoScroll,
      });
    } catch (_) {}
  }

  function loadPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(["open", "showTimes", "autoScroll"], (v) => {
          if (typeof v.open === "boolean") state.open = v.open;
          if (typeof v.showTimes === "boolean") state.showTimes = v.showTimes;
          if (typeof v.autoScroll === "boolean") state.autoScroll = v.autoScroll;
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Icons (inline SVG)
  // ---------------------------------------------------------------------------
  const svg = (paths, opts = {}) =>
    `<svg viewBox="0 0 24 24" width="${opts.size || 18}" height="${opts.size || 18}" fill="none" stroke="currentColor" stroke-width="${opts.w || 2}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const ICON = {
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', { size: 15 }),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', { size: 17, w: 1.8 }),
    download: svg('<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/>', { size: 17 }),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', { size: 16, w: 1.6 }),
    chevron: svg('<path d="m6 9 6 6 6-6"/>', { size: 14 }),
    expand: svg('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>', { size: 14 }),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>', { size: 16 }),
  };

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  function buildUI() {
    host = document.createElement("div");
    host.id = "yts-transcript-host";
    shadow = host.attachShadow({ mode: "open" });

    // Font (best-effort; falls back to system-ui if blocked by CSP).
    const font = document.createElement("link");
    font.rel = "stylesheet";
    font.href = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap";
    shadow.appendChild(font);

    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = chrome.runtime.getURL("sidebar.css");
    shadow.appendChild(css);

    const wrap = document.createElement("div");
    wrap.className = "yts";
    wrap.innerHTML = `
      <!-- Ribbon -->
      <div class="ribbon" part="ribbon">
        <div class="ribbon-bar"></div>
        <div class="mark mark-sm"><span class="mark-inner"></span></div>
        <div class="ribbon-meta">
          <div class="ribbon-title">Transcript</div>
          <div class="ribbon-sub">—</div>
        </div>
        <div class="ribbon-divider"></div>
        <button class="ribbon-expand" title="Open transcript">${ICON.expand}</button>
      </div>

      <!-- Panel -->
      <div class="panel">
        <div class="header">
          <div class="mark"><span class="mark-inner"></span></div>
          <div class="header-titles">
            <div class="title">Transcript</div>
            <div class="subtitle">YouTube extractor</div>
          </div>
          <div class="header-controls">
            <button class="ctrl ctrl-min" title="Collapse to ribbon"><span class="minus"></span></button>
            <button class="ctrl ctrl-close" title="Close">${ICON.close}</button>
          </div>
        </div>

        <div class="tabs">
          <button class="tab is-active" data-tab="transcript">Transcript</button>
          <button class="tab" data-tab="summary">Summary</button>
          <button class="tab" data-tab="chapters">Chapters</button>
        </div>

        <div class="toolbar">
          <label class="search">
            <span class="search-icon">${ICON.search}</span>
            <input class="search-input" type="text" placeholder="Search transcript…" />
          </label>
          <div class="toolbar-row">
            <div class="lang">
              <span class="lang-label">—</span>
              <span class="lang-chevron">${ICON.chevron}</span>
              <select class="lang-native"></select>
            </div>
            <button class="times" title="Toggle timestamps">
              <span class="switch"><span class="knob"></span></span>
              <span>Times</span>
            </button>
          </div>
        </div>

        <div class="list scl"></div>
        <div class="placeholder" hidden></div>

        <div class="footer">
          <div class="actions">
            <button class="btn-copy">${ICON.copy}<span>Copy all</span></button>
            <div class="menu-wrap">
              <button class="btn-ghost btn-download" title="Download .txt / .srt">${ICON.download}</button>
              <div class="menu menu-download" hidden>
                <button data-fmt="txt">Download .txt</button>
                <button data-fmt="srt">Download .srt</button>
              </div>
            </div>
            <div class="menu-wrap">
              <button class="btn-ghost btn-settings" title="Settings">${ICON.settings}</button>
              <div class="menu menu-settings" hidden>
                <label class="menu-toggle"><input type="checkbox" class="set-autoscroll" /> Auto-scroll to active line</label>
                <label class="menu-toggle"><input type="checkbox" class="set-times" /> Show timestamps</label>
              </div>
            </div>
          </div>
          <div class="meta">
            <span class="meta-count"><b>0</b> lines · <b>0:00</b></span>
            <span class="meta-status"><span class="dot"></span><span class="status-text">Idle</span></span>
          </div>
        </div>

        <div class="toast" hidden>
          <span class="toast-check">${svg('<path d="M5 12l4 4L19 7"/>', { size: 12, w: 3 })}</span>
          <span class="toast-text">Copied to clipboard</span>
        </div>
      </div>
    `;
    shadow.appendChild(wrap);

    els = {
      wrap,
      ribbon: wrap.querySelector(".ribbon"),
      ribbonSub: wrap.querySelector(".ribbon-sub"),
      ribbonExpand: wrap.querySelector(".ribbon-expand"),
      panel: wrap.querySelector(".panel"),
      min: wrap.querySelector(".ctrl-min"),
      close: wrap.querySelector(".ctrl-close"),
      tabs: [...wrap.querySelectorAll(".tab")],
      toolbar: wrap.querySelector(".toolbar"),
      search: wrap.querySelector(".search-input"),
      lang: wrap.querySelector(".lang"),
      langLabel: wrap.querySelector(".lang-label"),
      langNative: wrap.querySelector(".lang-native"),
      times: wrap.querySelector(".times"),
      list: wrap.querySelector(".list"),
      placeholder: wrap.querySelector(".placeholder"),
      copy: wrap.querySelector(".btn-copy"),
      download: wrap.querySelector(".btn-download"),
      menuDownload: wrap.querySelector(".menu-download"),
      settings: wrap.querySelector(".btn-settings"),
      menuSettings: wrap.querySelector(".menu-settings"),
      setAutoscroll: wrap.querySelector(".set-autoscroll"),
      setTimes: wrap.querySelector(".set-times"),
      metaCount: wrap.querySelector(".meta-count"),
      statusText: wrap.querySelector(".status-text"),
      dot: wrap.querySelector(".dot"),
      toast: wrap.querySelector(".toast"),
    };

    wireEvents();
    document.documentElement.appendChild(host);
  }

  function wireEvents() {
    els.ribbon.addEventListener("click", () => setOpen(true));
    els.min.addEventListener("click", () => setOpen(false));
    els.close.addEventListener("click", () => setOpen(false));

    els.tabs.forEach((t) =>
      t.addEventListener("click", () => {
        state.tab = t.dataset.tab;
        renderTabs();
      })
    );

    els.search.addEventListener("input", () => {
      state.query = els.search.value.trim().toLowerCase();
      renderList();
    });

    els.langNative.addEventListener("change", () => {
      state.language = els.langNative.value;
      loadTranscript(state.videoId, state.language);
    });

    els.times.addEventListener("click", () => {
      state.showTimes = !state.showTimes;
      persist();
      renderTimesToggle();
      renderList();
    });

    els.copy.addEventListener("click", () => copyAll());

    els.download.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu(els.menuDownload);
    });
    els.menuDownload.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        download(b.dataset.fmt);
        hideMenus();
      })
    );

    els.settings.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu(els.menuSettings);
    });
    els.setAutoscroll.addEventListener("change", () => {
      state.autoScroll = els.setAutoscroll.checked;
      persist();
    });
    els.setTimes.addEventListener("change", () => {
      state.showTimes = els.setTimes.checked;
      persist();
      renderTimesToggle();
      renderList();
    });

    // Close popovers on outside click.
    shadow.addEventListener("click", (e) => {
      if (!e.target.closest(".menu-wrap")) hideMenus();
    });
  }

  function toggleMenu(menu) {
    const willShow = menu.hidden;
    hideMenus();
    menu.hidden = !willShow;
  }
  function hideMenus() {
    els.menuDownload.hidden = true;
    els.menuSettings.hidden = true;
  }

  // ---- render passes --------------------------------------------------------
  function renderOpenState() {
    els.wrap.classList.toggle("is-open", state.open);
  }

  function renderTabs() {
    els.tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === state.tab));
    const isTranscript = state.tab === "transcript";
    els.toolbar.hidden = !isTranscript;
    if (isTranscript) {
      els.placeholder.hidden = true;
      els.list.hidden = false;
      renderList();
    } else {
      els.list.hidden = true;
      els.placeholder.hidden = false;
      els.placeholder.textContent =
        state.tab === "summary" ? "AI summary coming soon." : "Chapters coming soon.";
    }
  }

  function renderTimesToggle() {
    els.times.classList.toggle("is-on", state.showTimes);
    els.list.classList.toggle("no-times", !state.showTimes);
    if (els.setTimes) els.setTimes.checked = state.showTimes;
    if (els.setAutoscroll) els.setAutoscroll.checked = state.autoScroll;
  }

  function renderLanguages() {
    const langs = state.languages;
    els.lang.style.display = langs.length ? "" : "none";
    els.langNative.innerHTML = "";
    for (const l of langs) {
      const opt = document.createElement("option");
      opt.value = l.code;
      opt.textContent = l.label;
      if (l.code === state.language) opt.selected = true;
      els.langNative.appendChild(opt);
    }
    const current = langs.find((l) => l.code === state.language);
    els.langLabel.textContent = current ? current.label : "—";
  }

  function renderStatus() {
    const map = {
      idle: ["Idle", "idle"],
      extracting: ["Extracting…", "busy"],
      ready: ["Extracted", "ready"],
      none: ["No transcript available", "none"],
    };
    const [text, cls] = map[state.status] || map.idle;
    els.statusText.textContent = text;
    els.dot.className = "dot dot-" + cls;

    const count = state.segments.length;
    els.metaCount.innerHTML = `<b>${count}</b> lines · <b>${formatTime(totalDuration())}</b>`;

    els.ribbonSub.textContent =
      state.status === "extracting"
        ? "extracting…"
        : count
        ? `${count} lines · ready`
        : "no transcript";
  }

  function renderList() {
    rowEls = [];
    els.list.innerHTML = "";

    if (state.status === "extracting") {
      els.list.innerHTML = `<div class="empty">Extracting transcript…</div>`;
      return;
    }
    if (!state.segments.length) {
      els.list.innerHTML = `<div class="empty">No transcript available for this video.</div>`;
      return;
    }

    const q = state.query;
    const frag = document.createDocumentFragment();
    let shown = 0;
    state.segments.forEach((seg, i) => {
      const matches = !q || seg.text.toLowerCase().includes(q);
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.index = i;
      if (i === state.activeIndex) row.classList.add("is-active");
      if (!matches) row.hidden = true;
      else shown++;
      row.innerHTML = `<div class="row-bg"></div><div class="ts">${formatTime(seg.start)}</div><div class="tx"></div>`;
      row.querySelector(".tx").textContent = seg.text;
      row.addEventListener("click", () => seekTo(seg.start));
      frag.appendChild(row);
      rowEls[i] = row;
    });
    els.list.appendChild(frag);

    if (q && shown === 0) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = `No lines match “${state.query}”.`;
      els.list.appendChild(e);
    }
  }

  function renderAll() {
    renderOpenState();
    renderTabs();
    renderTimesToggle();
    renderLanguages();
    renderStatus();
    renderList();
  }

  // ---- actions --------------------------------------------------------------
  function setOpen(open) {
    state.open = open;
    persist();
    renderOpenState();
    if (open && state.status === "idle" && state.videoId) {
      loadTranscript(state.videoId, state.language);
    }
  }

  function getVideo() {
    if (video && document.contains(video)) return video;
    video = document.querySelector("video.html5-main-video, video");
    return video;
  }

  function seekTo(seconds) {
    const v = getVideo();
    if (v) {
      v.currentTime = seconds;
      v.play && v.play().catch(() => {});
    }
  }

  function transcriptText() {
    return state.segments
      .map((s) => (state.showTimes ? `${formatTime(s.start)}  ${s.text}` : s.text))
      .join("\n");
  }

  async function copyAll() {
    if (!state.segments.length) return;
    const text = transcriptText();
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    showToast();
  }

  function showToast() {
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 2000);
  }

  function buildSrt() {
    return state.segments
      .map((s, i) => {
        const next = state.segments[i + 1];
        const end = s.start + (s.dur || (next ? Math.min(next.start - s.start, 8) : 4));
        return `${i + 1}\n${srtTime(s.start)} --> ${srtTime(end)}\n${s.text}\n`;
      })
      .join("\n");
  }

  function download(fmt) {
    if (!state.segments.length) return;
    const content = fmt === "srt" ? buildSrt() : transcriptText();
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transcript-${state.videoId || "youtube"}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- active-line tracking -------------------------------------------------
  function onTimeUpdate() {
    if (!state.open || state.tab !== "transcript" || !state.segments.length) return;
    const v = getVideo();
    if (!v) return;
    const t = v.currentTime;
    const segs = state.segments;
    let idx = -1;
    // Linear scan is fine for a few hundred lines.
    for (let i = 0; i < segs.length; i++) {
      const start = segs[i].start;
      const end = segs[i].dur ? start + segs[i].dur : (segs[i + 1] ? segs[i + 1].start : Infinity);
      if (t >= start && t < end) { idx = i; break; }
      if (t < start) { idx = Math.max(0, i - 1); break; }
    }
    if (idx === state.activeIndex) return;
    const prev = rowEls[state.activeIndex];
    if (prev) prev.classList.remove("is-active");
    state.activeIndex = idx;
    const cur = rowEls[idx];
    if (cur) {
      cur.classList.add("is-active");
      if (state.autoScroll && !state.query) {
        const top = cur.offsetTop;
        const bottom = top + cur.offsetHeight;
        const list = els.list;
        if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
          list.scrollTop = top - list.clientHeight / 2 + cur.offsetHeight / 2;
        }
      }
    }
  }

  function attachVideoListener() {
    const v = getVideo();
    if (v && v !== attachVideoListener._v) {
      if (attachVideoListener._v) attachVideoListener._v.removeEventListener("timeupdate", onTimeUpdate);
      v.addEventListener("timeupdate", onTimeUpdate);
      attachVideoListener._v = v;
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation + lifecycle
  // ---------------------------------------------------------------------------
  function onNavigate() {
    const vid = getVideoId();
    if (vid === state.videoId) return;
    state.videoId = vid;
    state.segments = [];
    state.languages = [];
    state.language = null;
    state.query = "";
    state.activeIndex = -1;
    state.status = "idle";
    if (els.search) els.search.value = "";
    attachVideoListener._v = null;
    renderAll();
    if (vid) {
      // Extract eagerly so the ribbon shows a real line count.
      loadTranscript(vid, null);
      attachVideoListener();
    }
  }

  async function init() {
    await loadPrefs();
    buildUI();
    state.videoId = getVideoId();
    renderAll();
    if (state.videoId) {
      loadTranscript(state.videoId, null);
      attachVideoListener();
    }

    document.addEventListener("yt-navigate-finish", onNavigate);
    window.addEventListener("yt-page-data-updated", onNavigate);
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onNavigate();
      }
      attachVideoListener();
    }, 1000);

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "YTS_TOGGLE") setOpen(!state.open);
    });
  }

  init();
})();
