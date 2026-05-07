# Status Label + Upload Progress UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-visible `Server Status: <state>` colored label and circular upload-progress feedback (with success/failure toasts) to the Retribution Remote control web UI.

**Architecture:** Frontend-only changes confined to three existing files (`app/templates/partials/control.html`, `app/static/styles.css`, `app/static/script.js`). Three independent JS modules (`Toast`, `StatusLabel`, `UploadRing`) co-exist inside the existing `DOMContentLoaded` scope. The status label derives transitional `Starting…` / `Stopping…` states from in-flight POSTs (no backend signal). The upload uses `XMLHttpRequest` instead of `fetch` so byte-level progress events are available; all other API calls remain on `fetch`.

**Tech Stack:** Vanilla JavaScript (no build step, no framework), HTML5, CSS3 (SVG for the ring, CSS keyframes for the pulse). No new runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-06-ui-status-and-upload-progress-design.md`](../specs/2026-05-06-ui-status-and-upload-progress-design.md)

**Testing posture:** No automated test infrastructure exists in this repository (no pytest/jest, no JS test runner). Per the spec's Non-Goals, adding test infra is out of scope. Each task includes a **Visual Verification** step using the browser DevTools to manipulate classes/state directly so the rendering can be checked without a running DCS server, plus a final **Integration Smoke Test** section after Task 4 that runs the spec's 13-item checklist against a live deployment.

---

## File Structure

| File | Responsibility | Sections added |
|---|---|---|
| `app/templates/partials/control.html` | Markup for control UI: status label, modified upload button, toast slot | 3 modifications: insert `#status-label`, modify `#upload-button` children, append `#toast` |
| `app/static/styles.css` | Visual styling for the new components | 3 new sections appended: Toast, Status Label + amber token + pulse keyframe, Upload Ring + result icon + state classes |
| `app/static/script.js` | Behavior: 3 new modules + revised event handlers | Add `Toast`, `StatusLabel`, `UploadRing` modules near top of `DOMContentLoaded`; modify `updateUIWithServerStatus`, the power button click handler, the refresh button click handler, and `handleFileUpload`; add a `parseErrorDetail` helper |

No new files. No backend changes. No `requirements.txt` change.

---

## Glossary of CSS classes (introduced by this plan)

| Class | Where applied | Purpose |
|---|---|---|
| `.toast` | `#toast` div | Base toast appearance (fixed position, padding, transitions) |
| `.toast.hidden` | `#toast` | Toast not visible (opacity 0, no pointer events) |
| `.toast.success` | `#toast` | Green-tinted toast for success messages |
| `.toast.error` | `#toast` | Red-tinted toast for error messages |
| `.status-running` | `#status-label` | Green background |
| `.status-stopped` | `#status-label` | Red background |
| `.status-transitioning` | `#status-label` | Amber background + pulse animation |
| `.status-error` | `#status-label` | Red background, no pulse (distinct from `status-stopped` only by CSS rule, used to keep state machine explicit) |
| `.upload-icon-default` | `#upload-button > img` | Marker on the existing upload icon so it can be hidden when ring is active |
| `.upload-ring` | SVG inside `#upload-button` | The ring container |
| `.ring-track` | `<circle>` inside `.upload-ring` | The faint background ring |
| `.ring-progress` | `<circle>` inside `.upload-ring` | The animated progress arc |
| `.upload-pct` | `<span>` inside `#upload-button` | The numeric percentage shown during upload |
| `.upload-result-icon` | `<span>` inside `#upload-button` | Holds the success ✓ / error ✕ via `::after` |
| `#upload-button.uploading` | `#upload-button` | Compound state: upload in flight |
| `#upload-button.upload-success` | `#upload-button` | Compound state: just finished, showing ✓ for 2s |
| `#upload-button.upload-error` | `#upload-button` | Compound state: just failed, showing ✕ for 2s |

---

## Setup (run once before Task 1)

- [ ] **Create a feature branch.**

```bash
cd /Users/gfranks/workspace/dcs-retribution-remote
git checkout -b feat/status-label-and-upload-progress master
git status
```

Expected: `On branch feat/status-label-and-upload-progress` and a clean working tree.

---

## Task 1: Add the Toast component

**Why first:** Both the upload flow (Task 4) and the status-failure path (Task 3) display toasts. Implementing it first means later tasks can wire to a working module instead of stubbing.

**Files:**
- Modify: `app/templates/partials/control.html` (append `#toast` div)
- Modify: `app/static/styles.css` (append Toast section)
- Modify: `app/static/script.js` (add `Toast` module inside `DOMContentLoaded`)

- [ ] **Step 1: Add the toast element to `control.html`.**

Open `app/templates/partials/control.html`. Find the closing `</div>` of `.control-container` (the very last line). Insert the toast div immediately before that closing `</div>`:

```html
    <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
```

Final structure of `control.html`:

```html
<div class="control-container">
    <header>
        ...
    </header>
    <main>
        ...
    </main>
    <footer>
        ...
    </footer>
    <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
</div>
```

- [ ] **Step 2: Add Toast styles to `styles.css`.**

Append the following block to the end of `app/static/styles.css`:

```css
/* ----------------------------- */
/* Toast (single-slot, top-center) */
/* ----------------------------- */
.toast {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background-color: #48719D;
    color: #ffffff;
    padding: 10px 20px;
    border-radius: 8px;
    box-shadow: 0 0 8px rgba(0, 0, 0, 0.5);
    z-index: 100;
    max-width: 80vw;
    font-size: 0.95rem;
    font-family: Arial, sans-serif;
    cursor: pointer;
    opacity: 1;
    transition: opacity 0.3s ease;
}

.toast.hidden {
    opacity: 0;
    pointer-events: none;
}

.toast.success { background-color: #82A466; }
.toast.error   { background-color: #9E3232; }
```

- [ ] **Step 3: Add the `Toast` module to `script.js`.**

Open `app/static/script.js`. Locate the existing line near the top of the `DOMContentLoaded` callback:

```javascript
const appContainer = document.getElementById("app-container");
```

Immediately **after** that line, insert the following block:

```javascript
    // Toast: single-slot, ARIA-live status announcer at top-center.
    // Lazy-inits on every show() so the cached element is always current
    // even after renderControlUI/renderLoginUI replace appContainer's children.
    const Toast = {
        el: null,
        timer: null,
        init() {
            this.el = document.getElementById("toast");
            if (this.el && !this.el.dataset.bound) {
                this.el.addEventListener("click", () => this.hide());
                this.el.dataset.bound = "1";
            }
        },
        show(message, kind) {
            this.init();
            if (!this.el) return;
            clearTimeout(this.timer);
            this.el.textContent = message;
            this.el.classList.remove("hidden", "success", "error");
            this.el.classList.add(kind === "error" ? "error" : "success");
            const dwellMs = kind === "error" ? 5000 : 2000;
            this.timer = setTimeout(() => this.hide(), dwellMs);
        },
        hide() {
            if (!this.el) return;
            clearTimeout(this.timer);
            this.el.classList.add("hidden");
        },
    };
```

- [ ] **Step 4: Visual verification.**

Run the app (or open the existing deployment) and load the control UI in a browser at the configured host/port (e.g. `http://localhost:9099/`). Open DevTools → Console. After logging in and the control UI is rendered, type:

```javascript
document.getElementById("toast").classList.remove("hidden");
document.getElementById("toast").classList.add("success");
document.getElementById("toast").textContent = "Smoke test: success";
```

Expected: a green pill appears at the top-center of the page with the text "Smoke test: success".

Then:

```javascript
document.getElementById("toast").classList.remove("success");
document.getElementById("toast").classList.add("error");
document.getElementById("toast").textContent = "Smoke test: error";
```

Expected: pill turns red.

Click the pill. Expected: pill fades out (gets `.hidden`).

If the implementer cannot run the FastAPI app locally (Windows-only paths), they may instead open `app/templates/index.html` directly in a browser via `file://` URL after temporarily commenting out the `<script>` tag — the Toast styles are renderable with a manually-injected `<div id="toast" class="toast success">Smoke test</div>` snippet pasted into the body via DevTools.

- [ ] **Step 5: Commit.**

```bash
git add app/templates/partials/control.html app/static/styles.css app/static/script.js
git commit -m "Add Toast component for upload and status feedback

Single-slot, top-center, ARIA-live announcer with success (green, 2s)
and error (red, 5s) variants. Click-to-dismiss. Lazily inits on every
show() so it survives renderControlUI/renderLoginUI swaps."
```

---

## Task 2: Add the Status Label — basic running/stopped binding

**Why second:** Establishes the static `Server Status: <state>` UI element wired to the existing `/api/v1/status` flow. Task 3 will extend it with transitional and failure states; doing it in two steps makes the diff legible and the wiring testable in isolation.

**Files:**
- Modify: `app/templates/partials/control.html` (insert `#status-label` between `<header>` and `<main>`)
- Modify: `app/static/styles.css` (append Status Label section + amber token + pulse keyframe)
- Modify: `app/static/script.js` (add `StatusLabel` module; modify `updateUIWithServerStatus` to drive it)

- [ ] **Step 1: Add the status label markup to `control.html`.**

In `app/templates/partials/control.html`, find the closing `</header>` tag. Insert the status label immediately after `</header>` and before `<main>`:

```html
    </header>
    <div id="status-label" class="status-stopped" aria-live="polite">
        Server Status: <span id="status-value">Stopped</span>
    </div>
    <main>
```

`aria-live="polite"` lets screen readers announce state changes without interrupting the user.

- [ ] **Step 2: Add Status Label styles to `styles.css`.**

Append the following block to the end of `app/static/styles.css` (after the Toast block from Task 1):

```css
/* ----------------------------- */
/* Status Label                  */
/* ----------------------------- */
#status-label {
    margin: 0 auto 16px;
    padding: 8px 18px;
    border-radius: 20px;
    background-color: #9E3232;
    color: #ffffff;
    font-size: 1.05rem;
    font-weight: 600;
    box-shadow: 0 0 8px rgba(0, 0, 0, 0.5);
    text-align: center;
    min-width: 220px;
    display: inline-block;
    transition: background-color 0.3s ease;
}

#status-label.status-running       { background-color: #82A466; }
#status-label.status-stopped       { background-color: #9E3232; }
#status-label.status-error         { background-color: #9E3232; }
#status-label.status-transitioning {
    background-color: #C9A227; /* amber */
    animation: status-pulse 1.5s ease-in-out infinite;
}

@keyframes status-pulse {
    0%   { opacity: 1; }
    50%  { opacity: 0.55; }
    100% { opacity: 1; }
}
```

- [ ] **Step 3: Add the `StatusLabel` module to `script.js`.**

In `app/static/script.js`, immediately **after** the `Toast` module added in Task 1, insert the following:

```javascript
    // StatusLabel: derives Server Status text + color class.
    // States: running | stopped | starting | stopping | failed
    // Transitional and failed states are extended in Task 3; this version
    // covers only running/stopped, driven by /api/v1/status responses.
    const StatusLabel = {
        el: null,
        valueEl: null,
        recoveryTimer: null,
        init() {
            this.el = document.getElementById("status-label");
            this.valueEl = document.getElementById("status-value");
        },
        setState(state, opts) {
            this.init();
            if (!this.el || !this.valueEl) return;
            opts = opts || {};
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = null;

            const map = {
                running:  { text: "Running",         cls: "status-running" },
                stopped:  { text: "Stopped",         cls: "status-stopped" },
                starting: { text: "Starting…",  cls: "status-transitioning" },
                stopping: { text: "Stopping…",  cls: "status-transitioning" },
                failed:   {
                    text: opts.action === "stop" ? "Failed to stop" : "Failed to start",
                    cls: "status-error",
                },
            };
            const entry = map[state] || map.stopped;

            this.el.classList.remove(
                "status-running", "status-stopped",
                "status-transitioning", "status-error"
            );
            this.el.classList.add(entry.cls);
            this.valueEl.textContent = entry.text;
        },
        cancelRecovery() {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = null;
        },
    };
```

Note: `cancelRecovery()` is intentionally exposed here even though no recovery timer is started in this task — Task 3 will call `cancelRecovery()` from event handlers, and putting the no-op stub here keeps the module signature stable across commits.

- [ ] **Step 4: Wire `StatusLabel` into `updateUIWithServerStatus`.**

In `app/static/script.js`, find the existing `updateUIWithServerStatus` function. Replace its body so it calls `StatusLabel.setState(...)` in addition to the existing button class swaps. The full revised function:

```javascript
    // Update the UI with server status
    const updateUIWithServerStatus = (data) => {
        const powerButton = document.getElementById("power-button");
        const uploadButton = document.getElementById("upload-button");

        if (data.status === "running") {
            powerButton.classList.replace("off", "on");
            powerButton.setAttribute("data-tooltip", "Stop Server");
            uploadButton.classList.add("disabled");
            uploadButton.setAttribute("disabled", "true");
            StatusLabel.setState("running");
        } else {
            powerButton.classList.replace("on", "off");
            powerButton.setAttribute("data-tooltip", "Start Server");
            uploadButton.classList.remove("disabled");
            uploadButton.removeAttribute("disabled");
            StatusLabel.setState("stopped");
        }

        uploadButton.setAttribute("data-tooltip", data.allowed_filenames.join(" "));
    };
```

- [ ] **Step 5: Visual verification.**

Load the control UI in a browser. Verify the page now shows a `Server Status: Stopped` red pill above the button row on initial load (when DCS is not running).

Open DevTools → Console and run:

```javascript
document.getElementById("status-label").className = "status-running";
document.getElementById("status-value").textContent = "Running";
```

Expected: pill turns green, text updates.

```javascript
document.getElementById("status-label").className = "status-transitioning";
document.getElementById("status-value").textContent = "Starting…";
```

Expected: pill turns amber and pulses (1.5s cycle).

```javascript
document.getElementById("status-label").className = "status-error";
document.getElementById("status-value").textContent = "Failed to start";
```

Expected: pill turns red, no animation.

Click the manual refresh button. Expected: label snaps back to whatever the server returns (`Running` or `Stopped`).

- [ ] **Step 6: Commit.**

```bash
git add app/templates/partials/control.html app/static/styles.css app/static/script.js
git commit -m "Add Server Status label with running and stopped states

Always-visible colored pill above the action button row. Bound to
/api/v1/status responses via updateUIWithServerStatus. Includes amber
status-transitioning class and pulse keyframe so Task 3's transitional
states render against the correct base styles."
```

---

## Task 3: Status Label — transitional and failure states

**Why third:** Task 2 left `StatusLabel.setState("starting"|"stopping"|"failed")` callable but un-called. This task wires the power button click handler and the refresh button handler to use those states, plus the 5-second auto-recovery from `failed`.

**Files:**
- Modify: `app/static/script.js` (extend `StatusLabel.setState` to schedule the recovery timer; modify the power button click handler; modify the refresh button click handler)

- [ ] **Step 1: Extend `StatusLabel.setState` to schedule the failure-recovery timer.**

In `app/static/script.js`, find the `setState` method on the `StatusLabel` object (added in Task 2). After the line that sets `this.valueEl.textContent = entry.text;`, insert the recovery-timer logic so the full method body becomes:

```javascript
        setState(state, opts) {
            this.init();
            if (!this.el || !this.valueEl) return;
            opts = opts || {};
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = null;

            const map = {
                running:  { text: "Running",         cls: "status-running" },
                stopped:  { text: "Stopped",         cls: "status-stopped" },
                starting: { text: "Starting…",  cls: "status-transitioning" },
                stopping: { text: "Stopping…",  cls: "status-transitioning" },
                failed:   {
                    text: opts.action === "stop" ? "Failed to stop" : "Failed to start",
                    cls: "status-error",
                },
            };
            const entry = map[state] || map.stopped;

            this.el.classList.remove(
                "status-running", "status-stopped",
                "status-transitioning", "status-error"
            );
            this.el.classList.add(entry.cls);
            this.valueEl.textContent = entry.text;

            if (state === "failed") {
                // Auto-recover after 5s by re-fetching real status.
                // If the fetch itself errors (server unreachable, 5xx),
                // fetchAndUpdateStatus's own .catch swallows it: the label
                // stays in `failed` and no further timer is scheduled here.
                this.recoveryTimer = setTimeout(() => {
                    this.recoveryTimer = null;
                    if (typeof fetchAndUpdateStatus === "function") {
                        fetchAndUpdateStatus();
                    }
                }, 5000);
            }
        },
```

The only change vs Task 2 is the `if (state === "failed") { ... }` block at the end. Everything else is verbatim from Task 2 to keep the diff readable.

- [ ] **Step 2: Modify the power button click handler.**

In `app/static/script.js`, find the existing `powerButton.addEventListener("click", () => { ... });` block inside `setupButtonListeners`. Replace it with:

```javascript
        powerButton.addEventListener("click", () => {
            const isOn = powerButton.classList.contains("on");
            const action = isOn ? "stop" : "start";
            const url = isOn ? "/api/v1/server/stop" : "/api/v1/server/start";

            StatusLabel.cancelRecovery();
            StatusLabel.setState(isOn ? "stopping" : "starting");

            toggleRefreshSpinner(true);
            fetch(url, {
                method: "POST",
                headers: { Authorization: getAuthHeader() },
            })
                .then(handleFetchError)
                .then(fetchAndUpdateStatus)
                .catch((error) => {
                    console.error("Error toggling server power:", error);
                    StatusLabel.setState("failed", { action });
                })
                .finally(() => toggleRefreshSpinner(false));
        });
```

Two changes vs the original:
- Added `StatusLabel.cancelRecovery()` and `StatusLabel.setState(isOn ? "stopping" : "starting")` before the POST.
- The `.catch` now sets `StatusLabel.setState("failed", { action })` in addition to logging.

The 401 path (where `handleFetchError` calls `renderLoginUI()` and throws) still flows through `.catch`, which will momentarily set `failed` — but since the control UI has already been swapped out for the login UI, the user never sees it. No additional handling needed.

- [ ] **Step 3: Modify the refresh button click handler.**

Still in `setupButtonListeners`, find:

```javascript
        refreshButton.addEventListener("click", fetchAndUpdateStatus);
```

Replace with:

```javascript
        refreshButton.addEventListener("click", () => {
            StatusLabel.cancelRecovery();
            fetchAndUpdateStatus();
        });
```

This ensures a manual refresh during the 5-second `failed` recovery window snaps the label to actual server state immediately and cancels the pending recovery.

- [ ] **Step 4: Visual verification.**

Load the control UI in a browser. Click the power button.

Expected sequence (assuming a working DCS config):
1. Label flips to amber `Server Status: Starting…` and pulses.
2. After ~5–10 seconds, label settles to green `Server Status: Running`.
3. Click power again → label shows amber `Server Status: Stopping…` → settles to red `Server Status: Stopped`.

To exercise the failure path without breaking the real config, force a failure by temporarily blocking the `/api/v1/server/start` request in DevTools:

- DevTools → Network → right-click the URL → "Block request URL".
- Click power.

Expected:
- Label briefly shows `Server Status: Starting…` (amber pulse) while the blocked request hangs/fails.
- Label transitions to red `Server Status: Failed to start`.
- After 5 seconds, label re-fetches `/api/v1/status` and settles to whichever real state the server reports.

Unblock the request before continuing. Verify the manual refresh button still works and that clicking it during the 5s `failed` window cancels the auto-recovery (the label updates immediately on the manual click).

- [ ] **Step 5: Commit.**

```bash
git add app/static/script.js
git commit -m "Add transitional and failed states to Server Status label

Power button click sets Starting/Stopping before POST and Failed on
error; refresh button cancels the 5s recovery timer. Recovery falls
through fetchAndUpdateStatus, which silently no-ops on its own errors
so a genuinely-down server does not produce an infinite retry loop."
```

---

## Task 4: Upload Ring + XHR upload migration

**Why fourth:** Largest single task in the plan because the markup, styles, JS module, and call-site all need to land together — partial implementations don't render usefully. Toast (Task 1) is already in place and is consumed here.

**Files:**
- Modify: `app/templates/partials/control.html` (replace upload button children)
- Modify: `app/static/styles.css` (append Upload Ring section)
- Modify: `app/static/script.js` (add `UploadRing` module, `parseErrorDetail` helper, replace `fetch`-based upload with XHR; gate the upload button click while uploading)

- [ ] **Step 1: Modify the upload button markup in `control.html`.**

In `app/templates/partials/control.html`, find the existing upload button block:

```html
<button id="upload-button" class="action-button" data-tooltip="Upload .miz" type="file" accept=".miz">
    <img src="/static/ui/upload.svg" alt="Upload Icon">
</button>
```

Replace it with:

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

The existing `type="file" accept=".miz"` attributes were never functional on a `<button>` element (those belong on `<input type="file">`, which already exists separately on the next line); dropping them here is intentional cleanup directly tied to this change.

- [ ] **Step 2: Add Upload Ring styles to `styles.css`.**

Append the following block to the end of `app/static/styles.css` (after the Status Label block from Task 2):

```css
/* ----------------------------- */
/* Upload progress ring          */
/* ----------------------------- */
#upload-button { overflow: visible; }

.upload-ring,
.upload-pct,
.upload-result-icon {
    display: none;
    position: absolute;
    pointer-events: none;
}

.upload-ring {
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg); /* start fill at 12 o'clock */
}

.ring-track {
    fill: none;
    stroke: rgba(255, 255, 255, 0.25);
    stroke-width: 6;
}

.ring-progress {
    fill: none;
    stroke: #C9A227;            /* amber default during upload */
    stroke-width: 6;
    stroke-linecap: round;
    stroke-dasharray: 276.46;   /* 2 * π * 44 */
    stroke-dashoffset: 276.46;  /* hidden initially */
    transition: stroke-dashoffset 0.15s linear, stroke 0.2s ease;
}

.upload-pct {
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #ffffff;
    font-weight: 700;
    font-size: 1.2rem;
}

.upload-result-icon {
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #ffffff;
    font-size: 2.5rem;
    line-height: 1;
}

/* Uploading state */
#upload-button.uploading .upload-icon-default { display: none; }
#upload-button.uploading .upload-ring,
#upload-button.uploading .upload-pct          { display: block; }

/* Success / error states */
#upload-button.upload-success .upload-icon-default,
#upload-button.upload-error   .upload-icon-default { display: none; }

#upload-button.upload-success .upload-ring,
#upload-button.upload-error   .upload-ring         { display: block; }

#upload-button.upload-success .upload-result-icon,
#upload-button.upload-error   .upload-result-icon  { display: block; }

#upload-button.upload-success .ring-progress       {
    stroke: #82A466;          /* green at completion */
    stroke-dashoffset: 0;
}
#upload-button.upload-success .upload-result-icon::after { content: "\2713"; } /* ✓ */

#upload-button.upload-error   .ring-progress       { stroke: #9E3232; } /* red */
#upload-button.upload-error   .upload-result-icon::after { content: "\2715"; } /* ✕ */
```

Note: the existing `.action-button img { width: 80%; height: 80%; ... }` rule still styles the icon when visible. The `display: none` rules above override `display` regardless of the existing width/height because `display: none` removes the element from layout entirely.

- [ ] **Step 3: Add the `UploadRing` module to `script.js`.**

In `app/static/script.js`, immediately **after** the `StatusLabel` module added in Task 2, insert the following:

```javascript
    // UploadRing: SVG progress ring overlay on #upload-button.
    // States: idle | uploading | success | error
    const UPLOAD_RING_CIRCUMFERENCE = 276.46; // 2 * pi * 44
    const UploadRing = {
        btn: null,
        progressEl: null,
        pctEl: null,
        state: "idle",
        init() {
            this.btn = document.getElementById("upload-button");
            this.progressEl = this.btn ? this.btn.querySelector(".ring-progress") : null;
            this.pctEl      = this.btn ? this.btn.querySelector(".upload-pct")    : null;
        },
        _setStateClass(state) {
            if (!this.btn) return;
            this.btn.classList.remove("uploading", "upload-success", "upload-error");
            if (state === "uploading") this.btn.classList.add("uploading");
            if (state === "success")   this.btn.classList.add("upload-success");
            if (state === "error")     this.btn.classList.add("upload-error");
        },
        start() {
            this.init();
            this.state = "uploading";
            if (this.pctEl) this.pctEl.textContent = "0%";
            if (this.progressEl) {
                this.progressEl.style.strokeDashoffset = String(UPLOAD_RING_CIRCUMFERENCE);
            }
            this._setStateClass("uploading");
        },
        update(pct) {
            if (this.state !== "uploading") return;
            const clamped = Math.max(0, Math.min(100, pct));
            const offset = UPLOAD_RING_CIRCUMFERENCE * (1 - clamped / 100);
            if (this.progressEl) this.progressEl.style.strokeDashoffset = String(offset);
            if (this.pctEl) this.pctEl.textContent = Math.round(clamped) + "%";
        },
        succeed() {
            this.state = "success";
            if (this.progressEl) this.progressEl.style.strokeDashoffset = "0";
            this._setStateClass("success");
            setTimeout(() => this.reset(), 2000);
        },
        fail() {
            this.state = "error";
            this._setStateClass("error");
            setTimeout(() => this.reset(), 2000);
        },
        reset() {
            this.state = "idle";
            if (this.progressEl) {
                this.progressEl.style.strokeDashoffset = String(UPLOAD_RING_CIRCUMFERENCE);
            }
            this._setStateClass("idle");
        },
    };

    // parseErrorDetail: extract FastAPI HTTPException(detail=...) text from xhr.responseText
    const parseErrorDetail = (xhr) => {
        try {
            const obj = JSON.parse(xhr.responseText);
            return obj && obj.detail ? String(obj.detail) : null;
        } catch (_) {
            return null;
        }
    };
```

- [ ] **Step 4: Replace `fetch`-based upload with XHR in `handleFileUpload`.**

In `app/static/script.js`, find the existing `handleFileUpload` function. Replace its body (keeping the same function signature and the existing client-side filename + size validation at the top) with:

```javascript
    // Handle file upload
    const handleFileUpload = (file) => {
        const allowedFilenames = serverInfo.allowed_filenames || ["retribution_nextturn.miz", "liberation_nextturn.miz"];
        const maxFileSizeMB = serverInfo.allowed_max_size || 1000;

        if (!allowedFilenames.includes(file.name)) {
            alert(`Invalid file: ${file.name}.`);
            return;
        }

        const fileSizeMB = file.size / (1024 * 1024);
        if (fileSizeMB > maxFileSizeMB) {
            alert(`File size exceeds the limit of ${maxFileSizeMB} MB. Your file is ${fileSizeMB.toFixed(2)} MB.`);
            return;
        }

        const formData = new FormData();
        formData.append("file", file);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/v1/files/upload_miz");
        xhr.setRequestHeader("Authorization", getAuthHeader());

        xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) {
                UploadRing.update((e.loaded / e.total) * 100);
            }
        });

        xhr.addEventListener("load", () => {
            toggleRefreshSpinner(false);
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

        xhr.addEventListener("error", () => {
            toggleRefreshSpinner(false);
            UploadRing.fail();
            Toast.show("Network error during upload", "error");
        });

        xhr.addEventListener("timeout", () => {
            toggleRefreshSpinner(false);
            UploadRing.fail();
            Toast.show("Upload timed out", "error");
        });

        UploadRing.start();
        toggleRefreshSpinner(true);
        xhr.send(formData);
    };
```

Note: the existing fetch-based version called `fetchAndUpdateStatus` only on success (`.then(fetchAndUpdateStatus)` ran after `handleFetchError` did not throw; the `.catch` did not refresh status). The XHR version preserves this exactly: only the 2xx branch calls `fetchAndUpdateStatus()`. The 401, non-2xx, network-error, and timeout branches all skip the status refresh.

- [ ] **Step 5: Gate the upload button click while uploading.**

Still in `setupButtonListeners`, find the existing upload button click handler:

```javascript
        uploadButton.addEventListener("click", () => {
            if (!uploadButton.classList.contains("disabled")) {
                fileInput.click();
            }
        });
```

Replace with:

```javascript
        uploadButton.addEventListener("click", () => {
            if (uploadButton.classList.contains("disabled")) return;
            if (UploadRing.state === "uploading") return;
            fileInput.click();
        });
```

This prevents the user from re-triggering the file picker mid-upload (which would corrupt the in-flight XHR's UI state machine).

- [ ] **Step 6: Visual verification (DevTools-only, no live upload).**

Load the control UI. The upload button should look identical to before (white upload icon on a blue circle).

In DevTools → Console run:

```javascript
const btn = document.getElementById("upload-button");
btn.classList.add("uploading");
btn.querySelector(".upload-pct").textContent = "45%";
btn.querySelector(".ring-progress").style.strokeDashoffset = String(276.46 * (1 - 0.45));
```

Expected: upload icon disappears; the amber ring fills clockwise to ~45%; "45%" text appears in the center.

```javascript
btn.classList.remove("uploading");
btn.classList.add("upload-success");
```

Expected: ring goes solid green and a white ✓ appears in the center.

```javascript
btn.classList.remove("upload-success");
btn.classList.add("upload-error");
```

Expected: ring color flips to red, white ✕ in the center.

```javascript
btn.classList.remove("upload-error");
btn.querySelector(".ring-progress").style.strokeDashoffset = "276.46";
```

Expected: button returns to the default upload icon.

- [ ] **Step 7: Commit.**

```bash
git add app/templates/partials/control.html app/static/styles.css app/static/script.js
git commit -m "Add upload progress ring and migrate upload to XHR

Circular SVG ring overlays the upload button during uploads, showing
live percentage from xhr.upload progress events. Success flashes a
green check + toast for 2s; failure flashes a red cross + error toast
(5s, includes FastAPI detail when present). 401 mid-upload resets the
ring and bounces to the login UI without a toast."
```

---

## Final Integration Smoke Test

After Task 4 lands, run the full 13-item checklist from the spec against a live deployment. This is **not** a code-producing task — no commit. If any item regresses, file a fix as a follow-up commit on the same branch.

**Where to run:** the user's actual Retribution Remote dedicated server, or any environment where the FastAPI app starts cleanly (a working `config.yaml` with valid `dcs_mission_dir`, `dcs_server_exe`, etc.).

- [ ] **Smoke 1 — Cold load (server stopped):** open the page. Status label shows `Server Status: Stopped` (red).
- [ ] **Smoke 2 — Start (happy path):** click power. Label flips to `Starting…` (amber, pulsing) → settles to `Running` (green) once the POST returns. Upload button becomes disabled.
- [ ] **Smoke 3 — Start failure:** with a deliberately broken `dcs_server_exe` path in `config.yaml`, click power. Label briefly shows `Failed to start` (red); after 5s reverts to `Stopped`.
- [ ] **Smoke 4 — Stop server:** click power while `Running`. Label shows `Stopping…` → settles to `Stopped`. Upload button re-enables.
- [ ] **Smoke 5 — Upload happy path:** pick a real `.miz`. Ring animates 0→100% smoothly; green ✓ flashes 2s; success toast confirms. Power button stays enabled throughout.
- [ ] **Smoke 6 — Upload throttled:** DevTools → Network → Slow 3G; upload a ~50 MB file. Ring animates smoothly throughout, no jumps.
- [ ] **Smoke 7 — Upload invalid filename:** pick a `.txt`. Existing client-side `alert()` blocks; ring never starts.
- [ ] **Smoke 8 — Upload server rejection (403):** make `dcs_mission_dir` read-only on the server, then upload. Ring stops at the pct it reached when 403 returns; red ✕ flashes; error toast surfaces the FastAPI `detail` text.
- [ ] **Smoke 9 — Upload network error:** disconnect network mid-upload. Ring stops; red ✕; "Network error during upload" toast.
- [ ] **Smoke 10 — Upload while running:** existing disable preserved (upload button disabled when server is `Running`).
- [ ] **Smoke 11 — Auth 401 mid-upload:** clear `localStorage.auth` mid-upload (or revoke creds). XHR completes with 401 → login UI rendered. No error toast appears.
- [ ] **Smoke 12 — Toast click-dismiss:** during an active toast, click it — it disappears immediately.
- [ ] **Smoke 13 — Accessibility check:** with VoiceOver / NVDA, verify status changes and toast messages are announced.

If all pass, the implementation is ready for PR.

---

## Out of scope (per spec)

- Test infrastructure (no pytest/jest in repo).
- Backend streaming for upload (`await file.read()` left in place).
- Upload cancel UI.
- Download progress.
- Upstream PRs (Aterfax PR has been open for months unaddressed).
- Docker fork release work — separate plan after this UI PR merges.
