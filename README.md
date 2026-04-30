# SuperVip Desktop

Electron desktop app for opening supported video platform websites in an embedded browser and launching a configurable parser page for recognized video URLs.

## Run

```bash
npm install
npm start
```

## Implemented

- Opens supported platform home pages inside a desktop window.
- Uses Electron 41.3.0 and sends a normal desktop Chrome User-Agent for embedded pages.
- Supports direct URL input and simple search fallback.
- Detects video URLs for iQiyi, Youku, Tencent Video, MGTV, Bilibili, Sohu Video, and LeTV using the rules from `E:\project\learnplugin`.
- Captures candidate video links clicked inside the platform webview through an isolated preload script.
- Generates parser URLs as:

```text
parserInterfaceUrl + encodeURIComponent(originalVideoPageUrl)
```

- Loads the parser URL in a separate desktop webview.
- Persists selected parser interface, auto-parse setting, and recent parse history in Electron `userData`.

## Limits

This app does not decrypt, crack, scrape, or extract real media stream URLs. It only opens official platform pages and launches third-party parser pages with the current video page URL. Parser availability, legality, privacy, login behavior, and playback success depend on the selected external parser and the platform page itself.

Use it only for content you are authorized to access.

## iQiyi Browser Prompt

If iQiyi shows a browser upgrade/client prompt, this project now removes the Electron marker from the User-Agent and upgrades Electron to 41.3.0. That can help with browser-version checks, but iQiyi can still require its official client or DRM/media capabilities that embedded Chromium does not provide.
