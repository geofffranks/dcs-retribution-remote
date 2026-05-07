# UI Updates: Server Status Label + Upload Progress Feedback

**Date:** 2026-05-06
**Repository:** `geofffranks/dcs-retribution-remote` (fork of `omltcat/dcs-retribution-remote`)
**Status:** Design — pending implementation

## Summary

Two user-visible UI improvements to the Retribution Remote control web interface:

1. **Server Status label** — a colored, always-visible label (`Server Status: <state>`) above the action button row, replacing reliance on tooltip + button background color alone. Surfaces transitional `Starting…` / `Stopping…` states and start/stop failures that today only print to the JS console.
2. **Upload progress feedback** — a circular progress ring overlaid on the upload button while a `.miz` is uploading, with success/failure feedback via a single-slot toast and a brief check/cross icon overlay.

Both changes are frontend-only (`app/templates/partials/control.html`, `app/static/script.js`, `app/static/styles.css`). No backend, route, or `DCSControl` changes are required.

A **Downstream rollout** appendix lists the post-merge work needed to get these changes into the user's `geofffranks/DCS-World-Dedicated-Server-Docker` container build. That rollout is **not** part of this spec's implementation plan; it will be planned separately once the UI PR lands.

## Goals

- Make server status legible at a glance without hover, including during the ~10s window while DCS is starting.
- Surface start/stop failures in the UI rather than silently logging to the JS console.
- Replace the current "fire-and-forget upload then wait for `alert()`" pattern with continuous progress feedback during upload and clear success/failure outcomes after.
- Preserve existing visual language (palette, round buttons, tooltip behavior, footer link).

## Non-Goals

- Adding test infrastructure (no test runner exists in the repo today; out of scope).
- Reworking the upload backend to stream to disk instead of `await file.read()`.
- Adding upload cancellation UI.
- Adding a download progress indicator (not requested; download is typically small `state.json`).
- Restructuring the SPA, adding a build step, or introducing a frontend framework.
- Coordinating with the upstream `omltcat` or `Aterfax` repos. PRs upstream are explicitly out of scope per user direction (Aterfax PR has already been open for months unaddressed).

## Architecture

### Three discrete frontend units

Each is independently understandable and testable:

1. **`StatusLabel`** — renders the `Server Status: <state>` text + colored class. Driven by an explicit state machine: `running | stopped | starting | stopping | failed`. Exposes `setState(state, opts)` and reads no global mutable state of its own.
2. **`UploadRing`** — renders an SVG progress ring over the upload button, plus a center percentage text and a check/cross overlay. State machine: `idle | uploading | success | error`. Exposes `start()`, `update(pct)`, `succeed()`, `fail()`, `reset()`. `reset()` returns the button to `idle` immediately (used when the user is bounced to the login UI).
3. **`Toast`** — a single-slot, ARIA-live announcement region at top-center. Auto-dismisses (2s success, 5s error). Exposes `Toast.show(message, kind)` where `kind` is `"success" | "error"`.

These three components are wired together by the existing `setupButtonListeners()` and `fetchAndUpdateStatus()` flows in `script.js`. There is no shared mutable singleton; each component owns its own DOM and state.

### Why frontend-only

`DCSControl.start_process()` is synchronous — the FastAPI handler awaits the subprocess for up to 10 seconds before returning. The frontend can therefore derive the `Starting…` / `Stopping…` transitional states from "POST is in flight" without any backend signaling. The existing `/api/v1/status` endpoint already returns the `running | stopped` distinction; nothing more is needed.

The upload endpoint requires no change because progress events are emitted by the browser's XHR upload object — the server merely receives the request body as it always has.

### Why XHR for upload, fetch elsewhere

`fetch()` does not expose upload byte progress (the `ReadableStream` upload API is not consistently available across target browsers and would need polyfilling). `XMLHttpRequest.upload.addEventListener("progress", …)` works everywhere and is sufficient for this single use case. All other API calls (`/auth/validate`, `/server/start`, `/server/stop`, `/status`, `/files/state.json`) stay on `fetch()`.

## Status Label Component

### Markup

Inserted in `app/templates/partials/control.html`, between `<header>` and `<main>`:

```html
<div id="status-label" class="status-stopped" aria-live="polite">
  Server Status: <span id="status-value">Stopped</span>
</div>
```

`aria-live="polite"` lets screen readers announce state changes without interrupting the user.

### State machine

| State        | Display text             | CSS class               | Trigger                                                                                  |
|--------------|--------------------------|-------------------------|------------------------------------------------------------------------------------------|
| `running`    | `Running`                | `status-running`        | `/api/v1/status` returns `{"status": "running"}`                                         |
| `stopped`    | `Stopped`                | `status-stopped`        | `/api/v1/status` returns `{"status": "stopped"}`                                         |
| `starting`   | `Starting…`              | `status-transitioning`  | Power button clicked while previous state was `stopped`; persists until POST resolves    |
| `stopping`   | `Stopping…`              | `status-transitioning`  | Power button clicked while previous state was `running`; persists until POST resolves    |
| `failed`     | `Failed to start` / `Failed to stop` | `status-error`  | POST `/api/v1/server/start` or `/api/v1/server/stop` returns non-2xx, OR network error   |

The two `failed` text variants are selected by which POST failed: a failed `/server/start` shows `Failed to start`; a failed `/server/stop` shows `Failed to stop`. The click handler already knows which action it issued, so the failure text is set at the call site.

### Failure recovery

After entering `failed`, a 5-second timer is started. When it fires, `fetchAndUpdateStatus()` is called and its result drives the next state:

- If the fetch succeeds and returns `running` → label transitions to `running`.
- If the fetch succeeds and returns `stopped` → label transitions to `stopped`.
- If the fetch itself errors (server unreachable, 5xx) → label **stays in `failed`** with the same text, and no further auto-recovery timer is scheduled. The user can click power or the manual refresh button to retry. This avoids an infinite retry loop when the server is genuinely down.

The 5-second timer is cancelled if the user clicks the power button or the refresh button in the interim — the explicit user action takes precedence.

### Color tokens

| Token  | Hex       | Usage                                              |
|--------|-----------|----------------------------------------------------|
| green  | `#82A466` | `status-running` background (matches existing `.on`)|
| red    | `#9E3232` | `status-stopped`, `status-error` (matches existing `.off`)|
| amber  | `#C9A227` | `status-transitioning` background, new token       |

`status-transitioning` adds a 1.5s ease-in-out alpha pulse animation to make the transient nature visible.

### Interaction with existing power button

The power button keeps its existing `.on` / `.off` classes and green/red background. The status label is **additive** — it does not replace the button color. This keeps the change minimal and preserves muscle memory for existing users.

## Upload Progress Component

### Markup

Modifies the existing `#upload-button` in `control.html`:

```html
<button id="upload-button" class="action-button" data-tooltip="Upload .miz">
  <img src="/static/ui/upload.svg" alt="Upload Icon" class="upload-icon-default">
  <svg class="upload-ring" viewBox="0 0 100 100" aria-hidden="true">
    <circle class="ring-track"    cx="50" cy="50" r="44"/>
    <circle class="ring-progress" cx="50" cy="50" r="44"/>
  </svg>
  <span class="upload-pct" aria-hidden="true">0%</span>
  <span class="upload-result-icon" aria-hidden="true"></span>
</button>
```

`upload-ring`, `upload-pct`, and `upload-result-icon` are hidden by default via CSS and revealed based on state class on the button (`.uploading`, `.upload-success`, `.upload-error`).

### State machine

| State            | Visual                                                                          | Button click |
|------------------|---------------------------------------------------------------------------------|--------------|
| `idle`           | Upload icon visible. Ring, pct, result-icon hidden.                             | Opens file picker |
| `uploading`      | Ring stroke fills clockwise. `upload-pct` shows e.g. `45%`. Upload icon hidden. | Disabled (no-op) |
| `success`        | Ring full + green ✓ in `upload-result-icon`. Pct hidden.                        | Disabled (2s) |
| `error`          | Ring stops at last pct + red ✕ in `upload-result-icon`. Toast displayed.        | Disabled (2s) |

After the 2-second post-result delay, the button returns to `idle`.

### Progress math

```
circumference = 2 * π * r = 2 * π * 44 ≈ 276.46
stroke-dasharray  = circumference (set once in CSS)
stroke-dashoffset = circumference * (1 - pct / 100)   // updated on each progress event
```

The `.ring-progress` circle is rotated -90° via CSS `transform: rotate(-90deg)` so the fill starts at 12 o'clock and runs clockwise.

### XHR flow

Replacing `fetch()` inside `handleFileUpload(file)`:

```javascript
const xhr = new XMLHttpRequest();
xhr.open("POST", "/api/v1/files/upload_miz");
xhr.setRequestHeader("Authorization", getAuthHeader());

xhr.upload.addEventListener("progress", (e) => {
  if (e.lengthComputable) {
    UploadRing.update((e.loaded / e.total) * 100);
  }
});

xhr.addEventListener("load", () => {
  if (xhr.status === 401) {
    UploadRing.reset();
    localStorage.removeItem("auth");
    renderLoginUI();
    return;
  }
  if (xhr.status >= 200 && xhr.status < 300) {
    UploadRing.succeed();
    Toast.show(`Uploaded ${file.name}`, "success");
    fetchAndUpdateStatus();
  } else {
    UploadRing.fail();
    Toast.show(parseErrorDetail(xhr) || `Upload failed: HTTP ${xhr.status}`, "error");
  }
});

xhr.addEventListener("error",   () => { UploadRing.fail(); Toast.show("Network error during upload", "error"); });
xhr.addEventListener("timeout", () => { UploadRing.fail(); Toast.show("Upload timed out", "error"); });

const form = new FormData();
form.append("file", file);
UploadRing.start();
xhr.send(form);
```

`parseErrorDetail(xhr)` attempts `JSON.parse(xhr.responseText).detail` and falls back to plain status text — matches FastAPI's `HTTPException(detail=…)` shape.

### Auth handling

If the upload XHR receives a 401, behavior is:

1. The `UploadRing` is reset to `idle` (no error icon, no toast — the upload was not the user's failure).
2. `localStorage.auth` is cleared.
3. The login UI is re-rendered (replacing the control UI), matching the existing fetch-based 401 handler in `handleFetchError`.

The 401 check happens in the XHR `load` handler **before** the generic non-2xx branch, so a 401 never falls through to the error toast.

### Concurrency rules during upload

While `UploadRing.state === "uploading"`:

- The upload button itself is disabled (re-click does nothing).
- The power button and download button remain **enabled** — uploads do not conflict with server start/stop or state download.

## Toast Component

### Markup

Added once at the top of `control.html`:

```html
<div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
```

### Behavior

- Single slot. A new `Toast.show()` call replaces any current message immediately (no queueing).
- Success: green-tinted background, 2-second auto-dismiss.
- Error: red-tinted background, 5-second auto-dismiss.
- Click on the toast dismisses it immediately.
- Positioned `fixed; top: 20px; left: 50%; transform: translateX(-50%);` with a fade-in/fade-out transition.

## Files Changed

| File                                                  | Change                                                                                  |
|-------------------------------------------------------|-----------------------------------------------------------------------------------------|
| `app/templates/partials/control.html`                 | Add `#status-label`, `#toast`; modify `#upload-button` to include ring + pct + result-icon |
| `app/static/styles.css`                               | Add status label styles, ring SVG styles, toast styles, amber token, pulse keyframes    |
| `app/static/script.js`                                | Refactor `updateUIWithServerStatus` to drive `StatusLabel`; replace `fetch` upload with XHR + `UploadRing`; add `Toast` module; wire start/stop click handlers to `StatusLabel.setState("starting"|"stopping")` before POST and to `"failed"` on error |

No new files. No new backend dependencies. No `requirements.txt` change.

## Manual Test Checklist

To be run before merging the PR. No automated test infra exists today.

1. **Cold load (server stopped):** Page renders. Status label shows `Server Status: Stopped` (red).
2. **Start server (happy path):** Click power → label flips to `Starting…` (amber, pulsing) → label settles to `Running` (green) once POST returns. Upload button becomes disabled (existing).
3. **Start failure:** With a deliberately broken `dcs_server_exe` config path, click power → label briefly shows `Failed to start` (red) → after 5s reverts to `Stopped`.
4. **Stop server:** Click power while `Running` → label shows `Stopping…` (amber) → settles to `Stopped` (red). Upload button re-enables.
5. **Upload happy path:** Pick a real `.miz`. Ring animates from 0 to 100%, percentage updates smoothly. On finish: green ✓ flashes for 2s; success toast confirms. Power button remains enabled throughout.
6. **Upload throttled:** With DevTools Network → Slow 3G, upload a ~50 MB file. Verify ring animates smoothly throughout, no jumps.
7. **Upload invalid filename:** Pick a `.txt` file. Existing client-side `alert()` blocks. Ring never starts. (No regression.)
8. **Upload server rejection:** Make `dcs_mission_dir` read-only on the server, then upload a valid `.miz`. Ring stops at the pct it reached when 403 returns. Red ✕ flashes; error toast surfaces the FastAPI `detail` text.
9. **Upload network error:** Disconnect network mid-upload. Ring stops; red ✕ flashes; "Network error during upload" toast.
10. **Upload while server running:** Existing disable behavior preserved (upload button disabled when `Running`).
11. **Auth 401 during upload:** Clear `localStorage.auth` mid-upload (or revoke creds). XHR completes with 401 → login UI is rendered (existing pattern preserved).
12. **Toast click-dismiss:** Click an active toast — it disappears immediately.
13. **Accessibility check:** Use VoiceOver / NVDA to verify status changes and toast messages are announced.

## Downstream Rollout (Item #3) — Appendix, Not Part of UI Plan

After the UI PR is merged on `geofffranks/dcs-retribution-remote`, the following work ships these changes into the user's docker container. **This is a checklist for a future plan, not implementation steps for this spec.**

### Fork release

- Build the pyinstaller artifact: `pyinstaller pyinstaller.spec` on a Windows host (or Wine cross-build).
- Verify the produced zip's layout matches the upstream release shape so any consumer expecting `assets[0].browser_download_url` continues to work.
- Cut a tagged GitHub release on `geofffranks/dcs-retribution-remote` with the zip attached.
- **Follow-up (out of scope for the rollout plan):** add a GitHub Actions workflow that builds and publishes the release on tag push. Tracked separately.

### Docker installer change (chosen approach: A2a — env var with default)

Modify `docker/src/s6-services/s6-init-dcs-retribution-remote-auto-installer-updater-oneshot/run` in `geofffranks/DCS-World-Dedicated-Server-Docker`:

```bash
RETRIBUTION_REMOTE_REPO="${RETRIBUTION_REMOTE_REPO:-omltcat/dcs-retribution-remote}"
Retribution_remote_latest_release_manifest=$(curl -s "https://api.github.com/repos/${RETRIBUTION_REMOTE_REPO}/releases/latest")
```

Plus:

- Document `RETRIBUTION_REMOTE_REPO` in `docker-compose/Dedicated-Server-DockerMod-Retribution/.env.example` (commented default).
- Pass the variable through in `docker-compose/Dedicated-Server-DockerMod-Retribution/docker-compose.yml`'s `environment:` block.

Default behavior (no env var set) remains identical to upstream — anyone running stock images is unaffected.

### Private DockerMod image

The compose file references `aterfax/dcs-world-dedicated-server-mod-retribution:latest`. To run the patched s6 installer, the user needs:

- A private DockerMod image built from the patched fork (e.g. `geofffranks/dcs-world-dedicated-server-mod-retribution:latest`).
- Replace `DOCKER_MODS=aterfax/...` with the private image in their `.env` or compose override.
- Set `RETRIBUTION_REMOTE_REPO=geofffranks/dcs-retribution-remote` in `.env`.

### Verification

- Bring up the container fresh: `docker compose down -v && docker compose up`
- Confirm the s6 installer log shows it pulling the fork's release URL.
- Confirm the running Retribution Remote serves the new UI on `:9099` with the status label and upload ring visible.
