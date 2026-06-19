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

  // Extract the JSON array that follows `key` from a blob of text, matching
  // brackets while respecting strings. More reliable than a regex because
  // caption track objects can themselves contain nested arrays.
  function extractArrayAfter(text, key) {
    const keyIdx = text.indexOf(key);
    if (keyIdx === -1) return null;
    const start = text.indexOf("[", keyIdx);
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
      } else if (c === "[") {
        depth++;
      } else if (c === "]") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function parseCaptionTracks(text) {
    const arr = extractArrayAfter(text, '"captionTracks"');
    if (!arr) return [];
    try {
      return JSON.parse(arr);
    } catch (_) {
      return [];
    }
  }

  // The current page already embeds the player response (with valid, session
  // scoped caption URLs) in an inline <script>. Reading it avoids an extra
  // network round-trip and the EU consent interstitial. Only trusted when the
  // page is actually showing the video we want.
  function readCaptionTracksFromPage(videoId) {
    if (getVideoId() !== videoId) return [];
    for (const script of document.scripts) {
      const t = script.textContent;
      if (t && t.includes('"captionTracks"') && t.includes(videoId)) {
        const tracks = parseCaptionTracks(t);
        if (tracks.length) return tracks;
      }
    }
    return [];
  }

  // Fallback: fetch the watch page HTML and parse the caption tracks out of it.
  async function fetchCaptionTracks(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`Failed to load video page (${res.status})`);
    }
    return parseCaptionTracks(await res.text());
  }

  async function getCaptionTracks(videoId) {
    const fromPage = readCaptionTracksFromPage(videoId);
    if (fromPage.length) return fromPage;
    return fetchCaptionTracks(videoId);
  }

  function pickTrack(tracks) {
    if (!tracks.length) return null;
    // Prefer a manually-created English track, then any English, then any
    // manual track, then anything at all.
    const isEnglish = (t) => (t.languageCode || "").toLowerCase().startsWith("en");
    return (
      tracks.find((t) => isEnglish(t) && t.kind !== "asr") ||
      tracks.find((t) => isEnglish(t)) ||
      tracks.find((t) => t.kind !== "asr") ||
      tracks[0]
    );
  }

  function decodeEntities(str) {
    const ta = document.createElement("textarea");
    ta.innerHTML = str;
    return ta.value;
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

  async function fetchCaptionBody(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`captions HTTP ${res.status}`);
    return (await res.text()).trim();
  }

  // YouTube intermittently returns an empty body for a given caption format,
  // so try json3 first and fall back to the default XML format.
  async function fetchSegments(track) {
    const base = track.baseURL;

    try {
      const body = await fetchCaptionBody(base + "&fmt=json3");
      if (body) {
        const segs = parseJson3(JSON.parse(body));
        if (segs.length) return segs;
      }
    } catch (err) {
      console.debug("YouTube Transcript Sidebar: json3 failed", err);
    }

    const xml = await fetchCaptionBody(base);
    if (xml) {
      const segs = parseXmlCaptions(xml);
      if (segs.length) return segs;
    }

    throw new Error("captions returned no usable text");
  }

  async function loadTranscript(videoId) {
    setStatus("Loading transcript…", "loading");
    segments = [];
    renderSegments();
    try {
      const tracks = await getCaptionTracks(videoId);
      if (!tracks.length) {
        setStatus("No transcript is available for this video.", "empty");
        return;
      }
      const track = pickTrack(tracks);
      segments = await fetchSegments(track);
      if (!segments.length) {
        setStatus("No transcript is available for this video.", "empty");
        return;
      }
      const langName =
        (track.name && (track.name.simpleText || (track.name.runs && track.name.runs[0] && track.name.runs[0].text))) ||
        track.languageCode ||
        "";
      const auto = track.kind === "asr" ? " · auto-generated" : "";
      setStatus(`${segments.length} lines · ${langName}${auto}`, "ok");
      renderSegments();
    } catch (err) {
      console.error("YouTube Transcript Sidebar:", err);
      setStatus("Couldn't load the transcript. Try reloading the page.", "error");
    }
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
