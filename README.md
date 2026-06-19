# YouTube Transcript Sidebar

A Manifest V3 Chrome extension that extracts the transcript of the YouTube video
you're watching and presents it in a polished panel docked to the right of the
page. When closed, it collapses to an always-present **ribbon** pinned to the
top-right edge — click it to reopen.

Built to the high-fidelity design handoff: a sleek red / grey / white theme,
recreated as a real extension (no-build vanilla JS in a Shadow DOM).

## Features

- **Docked panel + ever-present ribbon.** 392px panel that slides in from the
  right; collapses to a top-right ribbon showing the live line count. State
  persists across reloads and SPA navigation (`chrome.storage.local`).
- **Robust transcript extraction** with three fallback strategies (see below),
  so it keeps working even when one path is blocked.
- **Search** — live, case-insensitive filtering of transcript lines.
- **Language switch** — pick any available caption track from the dropdown.
- **Timestamps toggle** — show/hide the timestamp column (persisted).
- **Click-to-seek** — click any line to jump the video to that moment.
- **Active-line tracking** — the currently-playing line is highlighted and
  auto-scrolled into view (toggleable in Settings).
- **Copy all** — copies the transcript to the clipboard with a toast.
- **Download** — `.txt` (`mm:ss  text`) or `.srt` (indexed, `HH:MM:SS,mmm`).
- **Footer status** — line count, total duration, and extraction state
  (Extracting… / Extracted / No transcript available).

## Install (Load Unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open a YouTube video. The ribbon appears top-right; click it (or the toolbar
   icon) to open the panel.

No build step — the extension loads directly.

## How it works

- The UI is mounted into a **Shadow DOM** so YouTube's CSS can't bleed in (and
  vice-versa). The shadow host is a click-through, clipped full-viewport layer,
  so the off-screen panel never adds a scrollbar to YouTube.
- The toolbar icon (`background.js`) toggles the panel; it injects the content
  script on demand if needed.
- `content.js` loads the transcript using three strategies, in order, stopping
  at the first that returns text:
  1. **Caption track URLs (timedtext)** — parses `captionTracks` from the watch
     page and downloads the selected language as `json3` (falling back to XML).
     This also powers the language dropdown.
  2. **`get_transcript` API** — the InnerTube endpoint YouTube's own "Show
     transcript" button uses; immune to the empty-body problem that affects raw
     caption URLs.
  3. **DOM scraping** — opens YouTube's own transcript panel and reads the
     rendered segments straight out of the page.
- SPA navigation is handled via `yt-navigate-finish` (plus a URL poll), so the
  transcript re-extracts when you switch videos without a full reload.

## Files

| File            | Purpose                                                    |
| --------------- | ---------------------------------------------------------- |
| `manifest.json` | Extension manifest (MV3).                                  |
| `background.js` | Service worker — toggles the panel on toolbar-icon click.  |
| `content.js`    | Transcript extraction + the full panel/ribbon UI + logic.  |
| `sidebar.css`   | Styles (design tokens), loaded into the Shadow DOM.        |
| `icons/`        | Toolbar / store icons.                                     |

## Notes & limitations

- Runs on `https://www.youtube.com/*` (watch pages and Shorts).
- Summary and Chapters tabs are placeholders (the design marks them as stretch).
- The panel uses 'Plus Jakarta Sans' (loaded from Google Fonts); if a page CSP
  blocks the webfont it falls back to the system UI font.
- If extraction ever breaks, `content.js` logs each strategy under
  `[Transcript Sidebar]` in the DevTools console.
