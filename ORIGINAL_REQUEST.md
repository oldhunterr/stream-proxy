# Original User Request

## Initial Request — 2026-06-20T15:36:14Z

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Investigate and fix an anomaly in the Heuristic Deep Scanner where it incorrectly flags network requests as playable streams for specific hosters (like Vibuxer and Rubyvidhub), causing the `/stream` endpoint to fail playback despite successful internal validation.

Working directory: c:\Users\Sayed Ali\Desktop\proxy
Integrity mode: benchmark

## Requirements

### R1. Investigate False Positives
Analyze the Deep Scanner's validation logic (`verifyUrl` / Range requests) to understand why it incorrectly marks certain `.m3u8` or `.js` chunks as playable video streams for `vibuxer.com` and `rubyvidhub.com`.

### R2. Improve Validation Heuristics (M3U8 Parsing)
Update the verification logic (in `browser.js` or `extract.js`) to strictly validate the contents of the stream. For `.m3u8` playlists, the deep scanner must parse the file contents and verify the presence of actual video segments (e.g., `#EXTINF`) before marking it as playable, rather than relying solely on HTTP 200/206 status codes.

## Acceptance Criteria

### Verification Checks
- [ ] The deep scanner no longer selects non-playable `jwplayer.js` or dummy `.m3u8` files for `rubyvidhub.com` or `vibuxer.com`.
- [ ] The `/stream` endpoint successfully returns the *actual* playable stream URL for both provided test links, or accurately reports failure without returning a false positive.
- [ ] Existing hosters (like Wistia, Mega, DoodStream) are unaffected by the updated heuristic logic.

---
*Next: when approved → delegate via invoke_subagent (see Delegation Protocol)*

## Follow-up — 2026-06-20T16:58:51Z

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Enhance the Heuristic Deep Scanner to automatically detect video streams across unfamiliar hoster domains by implementing generalized techniques like cross-origin iframe traversal, HTMLMediaElement hooking, and network JSON scraping.

Working directory: c:\Users\Sayed Ali\Desktop\proxy
Integrity mode: benchmark

## Requirements

### R1. Iframe Traversal
The scanner must recursively search for `<video>` tags and player instances inside all cross-origin iframes on the page, rather than just the top-level document.

### R2. Universal Player Hooking
Inject a script using `page.evaluateOnNewDocument` to aggressively proxy `HTMLMediaElement.prototype.play` and hook property setters for `HTMLVideoElement.prototype.src`. Any URLs intercepted via these hooks should be queued for stream verification.

### R3. XHR JSON Scraping
Intercept network responses with the `application/json` content type. Perform a global regex search on the response body to extract hidden `.m3u8` or `.mp4` URLs that are returned by the server.

## Acceptance Criteria

### Verification Checks
- [ ] You must write local HTML/JS test environments (e.g. `test_iframe.html`, `test_hook.html`, `test_json.js`) to reliably verify the extraction hooks are working before you deploy them to the main proxy server.
- [ ] A test page embedding a video via a cross-origin iframe is successfully detected by the scanner.
- [ ] A test page utilizing a highly custom or obfuscated player (not explicitly listed in `browser.js`) successfully triggers the `HTMLMediaElement` hooks and is detected.
- [ ] A test page that fetches its stream URL via a JSON API response successfully has its `.m3u8`/`.mp4` extracted and verified.

---
*Next: when approved → delegate via invoke_subagent (see Delegation Protocol)*

## Follow-up — 2026-06-21T03:36:51Z

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Investigate and fix a flaw in the deep scanner's stream verification logic where it incorrectly selects and returns `WEBVTT` thumbnail sprite tracks as playable video streams for `rubyvidhub.com` instead of the actual media stream.

Working directory: c:\Users\Sayed Ali\Desktop\proxy
Integrity mode: benchmark

## Requirements

### R1. Root Cause Investigation
Determine how the WEBVTT file bypasses the current verification checks (such as the `isStreamLike` exclusion list and the ASCII text density scanner in `routes/browser.js`) and gets incorrectly flagged as a valid video stream candidate.

### R2. Refine Verification Logic
Update `routes/browser.js` (and any related routing/extraction logic) to strictly identify and reject subtitle tracks, thumbnail sprites (e.g., `text/vtt` or WEBVTT content), and any other non-playable media tracks without breaking the parsing of legitimate `.m3u8`/`.mpd` playlists.

### R3. Fallback Retry Logic
If the deep scanner successfully filters out the WEBVTT file but initially fails to find any other valid video URL on that specific page, it must not simply fail immediately. It should continue scanning the DOM, waiting for dynamic elements, or trying to find an alternate URL until the timeout is reached.

### R4. Stremio Companion Mode (Video Error Responses)
Add an optional query parameter to the `/stream` or `/proxy` endpoints (e.g., `?video_error=true` or `?stremio=true`). When this flag is enabled and the proxy fails to resolve a valid stream, it must NOT return a JSON error object (which breaks media players like Stremio). Instead, it must dynamically generate or redirect to a short (e.g., 10-second) playable video stream that visually displays the error message to the user.

## Acceptance Criteria

### Verification Checks
- [ ] A programmatic or local test proves that `WEBVTT` files are correctly rejected during the `verifyUrl` process.
- [ ] Passing the provided link (`https://rubyvidhub.com/embed-rft2j1kblj7x.html`) through the proxy deep scanner correctly returns the actual video stream (or continues searching until timeout), completely ignoring the WEBVTT thumbnail sprite track.
- [ ] Requesting an invalid stream with `?stremio=true` successfully returns an HTTP 302 redirect or stream pipeline to a playable error video, rather than a JSON response or HTTP 500 error.

---
*Next: when approved → delegate via invoke_subagent (see Delegation Protocol)*

