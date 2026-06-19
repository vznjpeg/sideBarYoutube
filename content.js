(() => {
  "use strict";

  // Guard against double-injection (content script + on-demand injection).
  if (window.__ytsSidebarLoaded) {
    return;
  }
  window.__ytsSidebarLoaded = true;

  const PANEL_ID = "yts-transcript-sidebar-host";

  let host = null; // shadow host element
  let shadow = null; // shadow root
  let els = {}; // cached references to UI elements
  let currentVideoId = null;
  let segments = []; // [{ start, dur, text }]
  let isOpen = false;

  // ---------------------------------------------------------------------------
  // Transcript fetching
  // ---------------------------------------------------------------------------

  function getVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }
      if (url.pathname.startsWith("/shorts/")) {
        return url.pathname.split("/")[2] || null;
      }
    } catch (_) {
      /* noop */
    }
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(...args) {
    console.debug("[Transcript Sidebar]", ...args);
  }

  // Extract a balanced {...} or [...] region starting at the first `open`
  // character after `key`, respecting strings. More robust than regex because
  // YouTube's blobs contain deeply nested structures.
  function extractBalancedAfter(text, key, open, close) {
    const keyIdx = text.indexOf(key);
    if (keyIdx === -1) return null;
    const start = text.indexOf(open, keyIdx);
    if (start === -1) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === open) {
        depth++;
      } else if (c === close) {
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

  // Recursively collect every value stored under `key` anywhere in `obj`.
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

  const SOURCE_LABELS = {
    api: "YouTube API",
    captions: "captions",
    panel: "transcript panel",
  };

  function formatSegmentsStatus(source) {
    return `${segments.length} lines · via ${SOURCE_LABELS[source] || source}`;
  }

  // ---- Strategy 1: YouTube's get_transcript InnerTube API ------------------
  // This is the endpoint the on-page "Show transcript" button uses. It returns
  // the transcript directly, so it isn't affected by the empty-body problem
  // that now plagues the raw timedtext caption URLs.
  async function fetchWatchHtml(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error(`watch page HTTP ${res.status}`);
    return res.text();
  }

  function findTranscriptParams(initialData) {
    // The transcript engagement panel carries a getTranscriptEndpoint with the
    // continuation params we need to POST to get_transcript.
    const endpoints = deepCollect(initialData, "getTranscriptEndpoint", []);
    for (const ep of endpoints) {
      if (ep && ep.params) return ep.params;
    }
    return null;
  }

  function parseGetTranscript(data) {
    const renderers = deepCollect(data, "transcriptSegmentRenderer", []);
    const out = [];
    for (const r of renderers) {
      const snippet = r.snippet || {};
      const raw = snippet.runs
        ? snippet.runs.map((x) => x.text || "").join("")
        : snippet.simpleText || "";
      const text = raw.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const startMs = parseInt(r.startMs || "0", 10);
      const endMs = parseInt(r.endMs || "0", 10);
      out.push({ start: startMs / 1000, dur: (endMs - startMs) / 1000, text });
    }
    return out;
  }

  async function fetchViaGetTranscript(videoId, html) {
    if (!html) html = await fetchWatchHtml(videoId);
    const initialData = parseJsonAfter(html, "ytInitialData", "{", "}");
    const params = initialData && findTranscriptParams(initialData);
    if (!params) {
      log("get_transcript: no transcript params (video may have no captions)");
      return [];
    }
    const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
    const context = parseJsonAfter(html, '"INNERTUBE_CONTEXT":', "{", "}");
    if (!apiKey || !context) {
      log("get_transcript: missing API key or context");
      return [];
    }
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context, params }),
      }
    );
    if (!res.ok) throw new Error(`get_transcript HTTP ${res.status}`);
    return parseGetTranscript(await res.json());
  }

  // ---- Strategy 2: legacy timedtext caption URLs ---------------------------
  function decodeEntities(str) {
    const ta = document.createElement("textarea");
    ta.innerHTML = str;
    return ta.value;
  }

  function pickTrack(tracks) {
    if (!tracks.length) return null;
    const isEnglish = (t) => (t.languageCode || "").toLowerCase().startsWith("en");
    return (
      tracks.find((t) => isEnglish(t) && t.kind !== "asr") ||
      tracks.find((t) => isEnglish(t)) ||
      tracks.find((t) => t.kind !== "asr") ||
      tracks[0]
    );
  }

  function parseJson3(data) {
    const out = [];
    for (const event of data.events || []) {
      if (!event.segs) continue;
      const text = event.segs
        .map((s) => s.utf8 || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      out.push({
        start: (event.tStartMs || 0) / 1000,
        dur: (event.dDurationMs || 0) / 1000,
        text,
      });
    }
    return out;
  }

  function parseXmlCaptions(xml) {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const out = [];
    doc.querySelectorAll("text").forEach((node) => {
      const text = decodeEntities(node.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      out.push({
        start: parseFloat(node.getAttribute("start") || "0"),
        dur: parseFloat(node.getAttribute("dur") || "0"),
        text,
      });
    });
    return out;
  }

  async function fetchViaTimedText(videoId, html) {
    if (!html) html = await fetchWatchHtml(videoId);
    const tracks = parseJsonAfter(html, '"captionTracks"', "[", "]") || [];
    const track = pickTrack(tracks);
    if (!track || !track.baseURL) return [];

    try {
      const res = await fetch(track.baseURL + "&fmt=json3", { credentials: "include" });
      const body = (await res.text()).trim();
      if (body) {
        const segs = parseJson3(JSON.parse(body));
        if (segs.length) return segs;
      }
    } catch (err) {
      log("timedtext json3 failed", err);
    }

    const res = await fetch(track.baseURL, { credentials: "include" });
    const xml = (await res.text()).trim();
    return xml ? parseXmlCaptions(xml) : [];
  }

  // ---- Strategy 3: scrape YouTube's own rendered transcript panel ----------
  // The most resilient path: let YouTube render the transcript with its own
  // authenticated session, then read it straight out of the DOM.
  function parseTimestamp(str) {
    const parts = (str || "").trim().split(":").map(Number);
    if (!parts.length || parts.some(isNaN)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  function readRenderedSegments() {
    const nodes = document.querySelectorAll("ytd-transcript-segment-renderer");
    const out = [];
    nodes.forEach((node) => {
      const tx = node.querySelector(".segment-text");
      if (!tx) return;
      const text = (tx.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      const ts = node.querySelector(".segment-timestamp");
      out.push({ start: parseTimestamp(ts && ts.textContent), dur: 0, text });
    });
    return out;
  }

  function findTranscriptButton() {
    const direct = document.querySelector(
      'ytd-video-description-transcript-section-renderer button, button[aria-label*="transcript" i]'
    );
    if (direct) return direct;
    const candidates = document.querySelectorAll(
      "ytd-button-renderer, tp-yt-paper-button, button"
    );
    for (const c of candidates) {
      const t = (c.textContent || "").trim().toLowerCase();
      if (t === "show transcript" || t === "transcript") return c;
    }
    return null;
  }

  function closeTranscriptPanel() {
    const panel = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
    );
    if (!panel) return;
    const close = panel.querySelector(
      'button[aria-label="Close" i], ytd-engagement-panel-title-header-renderer button'
    );
    if (close) close.click();
  }

  async function scrapeTranscriptFromPanel(videoId) {
    if (getVideoId() !== videoId) return []; // DOM only reflects current video

    let segs = readRenderedSegments();
    if (segs.length) return segs;

    // Expand the description so the "Show transcript" button is in the DOM.
    const expand = document.querySelector("#description #expand, tp-yt-paper-button#expand");
    if (expand) {
      expand.click();
      await sleep(350);
    }

    const btn = findTranscriptButton();
    if (!btn) {
      log("panel: no Show transcript button found");
      return [];
    }
    btn.click();

    // Wait for YouTube to render the segments.
    for (let i = 0; i < 24 && !segs.length; i++) {
      await sleep(250);
      segs = readRenderedSegments();
    }
    if (segs.length) closeTranscriptPanel();
    return segs;
  }

  // ---- Orchestration -------------------------------------------------------
  async function loadTranscript(videoId) {
    setStatus("Loading transcript…", "loading");
    segments = [];
    renderSegments();

    // Both network strategies parse the same watch page; fetch it once.
    let html = null;
    try {
      html = await fetchWatchHtml(videoId);
    } catch (err) {
      log("watch page fetch failed", err);
    }

    const strategies = [
      ["api", () => fetchViaGetTranscript(videoId, html)],
      ["captions", () => fetchViaTimedText(videoId, html)],
      ["panel", () => scrapeTranscriptFromPanel(videoId)],
    ];

    for (const [name, run] of strategies) {
      try {
        log(`trying strategy: ${name}`);
        const segs = await run();
        if (segs && segs.length) {
          segments = segs;
          setStatus(formatSegmentsStatus(name), "ok");
          renderSegments();
          log(`strategy ${name} succeeded with ${segs.length} lines`);
          return;
        }
      } catch (err) {
        log(`strategy ${name} failed`, err);
      }
    }

    setStatus("No transcript is available for this video.", "empty");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function formatTime(seconds) {
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function plainText() {
    return segments.map((s) => s.text).join("\n");
  }

  function timestampedText() {
    return segments.map((s) => `[${formatTime(s.start)}] ${s.text}`).join("\n");
  }

  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // Fallback for restricted clipboard contexts.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    if (btn) {
      const original = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("yts-copied");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("yts-copied");
      }, 1500);
    }
  }

  function seekTo(seconds) {
    const video = document.querySelector("video");
    if (video) {
      video.currentTime = seconds;
      video.play().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function buildUI() {
    host = document.createElement("div");
    host.id = PANEL_ID;
    shadow = host.attachShadow({ mode: "open" });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("sidebar.css");
    shadow.appendChild(link);

    const panel = document.createElement("div");
    panel.className = "yts-panel";
    panel.innerHTML = `
      <header class="yts-header">
        <div class="yts-title">
          <span class="yts-logo">▶</span>
          <span>Transcript</span>
        </div>
        <button class="yts-icon-btn yts-close" title="Close">✕</button>
      </header>
      <div class="yts-toolbar">
        <button class="yts-btn yts-copy-plain" title="Copy transcript text">Copy</button>
        <button class="yts-btn yts-copy-ts" title="Copy with timestamps">Copy w/ time</button>
        <button class="yts-icon-btn yts-refresh" title="Reload transcript">⟳</button>
      </div>
      <div class="yts-search-wrap">
        <input type="text" class="yts-search" placeholder="Search transcript…" />
      </div>
      <div class="yts-status"></div>
      <div class="yts-list"></div>
    `;
    shadow.appendChild(panel);

    els = {
      panel,
      close: panel.querySelector(".yts-close"),
      copyPlain: panel.querySelector(".yts-copy-plain"),
      copyTs: panel.querySelector(".yts-copy-ts"),
      refresh: panel.querySelector(".yts-refresh"),
      search: panel.querySelector(".yts-search"),
      status: panel.querySelector(".yts-status"),
      list: panel.querySelector(".yts-list"),
    };

    els.close.addEventListener("click", () => closeSidebar());
    els.copyPlain.addEventListener("click", () => copyToClipboard(plainText(), els.copyPlain));
    els.copyTs.addEventListener("click", () => copyToClipboard(timestampedText(), els.copyTs));
    els.refresh.addEventListener("click", () => {
      if (currentVideoId) loadTranscript(currentVideoId);
    });
    els.search.addEventListener("input", () => renderSegments());

    document.documentElement.appendChild(host);
  }

  function setStatus(text, kind) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.dataset.kind = kind || "";
  }

  function renderSegments() {
    if (!els.list) return;
    const query = (els.search.value || "").trim().toLowerCase();
    els.list.innerHTML = "";

    const visible = query
      ? segments.filter((s) => s.text.toLowerCase().includes(query))
      : segments;

    const frag = document.createDocumentFragment();
    for (const seg of visible) {
      const row = document.createElement("div");
      row.className = "yts-row";

      const time = document.createElement("button");
      time.className = "yts-time";
      time.textContent = formatTime(seg.start);
      time.title = "Jump to this point";
      time.addEventListener("click", () => seekTo(seg.start));

      const text = document.createElement("span");
      text.className = "yts-text";
      text.textContent = seg.text;

      row.appendChild(time);
      row.appendChild(text);
      frag.appendChild(row);
    }
    els.list.appendChild(frag);
  }

  function openSidebar() {
    if (!host) buildUI();
    isOpen = true;
    els.panel.classList.add("yts-open");
    document.documentElement.classList.add("yts-pushed");
    const vid = getVideoId();
    if (vid && vid !== currentVideoId) {
      currentVideoId = vid;
      loadTranscript(vid);
    } else if (!vid) {
      segments = [];
      renderSegments();
      setStatus("Open a video to see its transcript.", "empty");
    }
  }

  function closeSidebar() {
    isOpen = false;
    if (els.panel) els.panel.classList.remove("yts-open");
    document.documentElement.classList.remove("yts-pushed");
  }

  function toggleSidebar() {
    if (isOpen) closeSidebar();
    else openSidebar();
  }

  // ---------------------------------------------------------------------------
  // SPA navigation handling
  // ---------------------------------------------------------------------------

  function onNavigate() {
    if (!isOpen) return;
    const vid = getVideoId();
    if (vid && vid !== currentVideoId) {
      currentVideoId = vid;
      if (els.search) els.search.value = "";
      loadTranscript(vid);
    } else if (!vid) {
      currentVideoId = null;
      segments = [];
      renderSegments();
      setStatus("Open a video to see its transcript.", "empty");
    }
  }

  // YouTube fires this custom event after client-side navigation.
  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", onNavigate);

  // Fallback: poll for URL changes in case the events don't fire.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
    }
  }, 1000);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "YTS_TOGGLE") {
      toggleSidebar();
    }
  });
})();
