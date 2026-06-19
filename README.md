# YouTube Transcript Sidebar

A Chrome extension (Manifest V3) that extracts the transcript of any YouTube
video you're watching and displays it in a clean sidebar — with one-click copy.

## Features

- **Transcript extraction** for any YouTube video that has captions (manual or
  auto-generated), in the video's own language (prefers English when available).
- **Sidebar UI** that slides in from the right, styled to match YouTube's dark
  theme.
- **Copy buttons**:
  - `Copy` — the plain transcript text.
  - `Copy w/ time` — the transcript with `[mm:ss]` timestamps.
- **Click-to-seek** — click any timestamp to jump the video to that point.
- **Search** — filter transcript lines as you type.
- **SPA-aware** — automatically reloads the transcript when you navigate to a
  new video without a full page reload.

## Install (Load Unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.
4. Open any YouTube video and click the extension's toolbar icon to toggle the
   sidebar.

## How it works

- Clicking the toolbar icon (handled in `background.js`) sends a toggle message
  to the content script.
- `content.js` fetches the video's watch page, parses the `captionTracks` list
  from the embedded player response, and downloads the captions as JSON
  (`fmt=json3`). All requests are same-origin to `www.youtube.com`.
- The UI is rendered inside a Shadow DOM so the extension's styles never clash
  with YouTube's, and vice versa.

## Files

| File            | Purpose                                            |
| --------------- | -------------------------------------------------- |
| `manifest.json` | Extension manifest (MV3).                          |
| `background.js` | Service worker — toggles the sidebar on icon click.|
| `content.js`    | Transcript fetching + sidebar UI logic.            |
| `sidebar.css`   | Styles for the sidebar (loaded into the Shadow DOM).|
| `icons/`        | Toolbar / store icons.                             |

## Notes & limitations

- Works only on `https://www.youtube.com/*` (regular videos and Shorts).
- Videos without any captions will show "No transcript is available."
- YouTube's internal page structure can change over time; if extraction breaks,
  the parsing logic in `getCaptionTracks` is the place to update.
