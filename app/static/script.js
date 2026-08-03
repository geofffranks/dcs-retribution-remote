// @ts-nocheck
document.addEventListener("DOMContentLoaded", () => {
    let serverInfo = {};
    const appContainer = document.getElementById("app-container");

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

    // StatusLabel: server status state machine + DOM updater.
    // States: running | stopped | starting | stopping | failed
    // Owns: the #status-label pill, the #power-button color class, the
    // #upload-button disabled state, the periodic status poll, and the
    // failure-recovery timer. setState() is the single mutator; everything
    // else (DOM + timers) is derived.
    const STATUS_STABLE_POLL_MS = 15000;
    const STATUS_TRANSITION_POLL_MS = 3000;
    const STATUS_TRANSITION_TIMEOUT_MS = 120000;
    const STATUS_FAILED_HOLD_MS = 15000;
    const STATUS_BACKOFF_MAX_MS = 30000;
    const StatusLabel = {
        el: null,
        valueEl: null,
        state: "stopped",
        recoveryTimer: null,
        pollTimer: null,
        transitionStartedAt: 0,
        // 429 back-off: while the server is rate-limiting our status polls we
        // poll more slowly (nextPollAt) and exclude the throttled time from the
        // transition timeout (throttledMs), so a 429 burst is never misreported
        // as "Failed to stop/start" — the server may have changed state fine,
        // we just couldn't ask. See noteRateLimited / clearRateLimit.
        throttledMs: 0,
        nextPollAt: 0,
        pollBackoffMs: 0,
        rateLimitNotified: false,
        init() {
            this.el = document.getElementById("status-label");
            this.valueEl = document.getElementById("status-value");
        },
        setState(state, opts) {
            this.init();
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

            if (this.el && this.valueEl) {
                this.el.classList.remove(
                    "status-running", "status-stopped",
                    "status-transitioning", "status-error"
                );
                this.el.classList.add(entry.cls);
                this.valueEl.textContent = entry.text;
            }

            this._updateButtons(state);

            if (state === "starting" || state === "stopping") {
                if (!this.transitionStartedAt) {
                    this.transitionStartedAt = Date.now();
                    this.throttledMs = 0;
                }
            } else {
                this.transitionStartedAt = 0;
            }

            this.state = state;

            if (state === "failed") {
                // Hold the failed message for STATUS_FAILED_HOLD_MS so the
                // user has time to read the toast that accompanied it, then
                // re-fetch real status. The next applyServerStatus call lifts
                // the state out of "failed" automatically (the filter in
                // applyServerStatus does NOT pin failed — only transitional).
                this.recoveryTimer = setTimeout(() => {
                    this.recoveryTimer = null;
                    if (typeof fetchAndUpdateStatus === "function") {
                        fetchAndUpdateStatus();
                    }
                }, STATUS_FAILED_HOLD_MS);
            }

            this._reschedulePoll();
        },
        _updateButtons(state) {
            const power = document.getElementById("power-button");
            if (power) {
                power.classList.remove("on", "off", "transitioning");
                if (state === "running") {
                    power.classList.add("on");
                    power.setAttribute("data-tooltip", "Stop Server");
                } else if (state === "starting") {
                    power.classList.add("transitioning");
                    power.setAttribute("data-tooltip", "Starting…");
                } else if (state === "stopping") {
                    power.classList.add("transitioning");
                    power.setAttribute("data-tooltip", "Stopping…");
                } else {
                    // stopped or failed
                    power.classList.add("off");
                    power.setAttribute("data-tooltip", "Start Server");
                }
            }
            const upload = document.getElementById("upload-button");
            if (upload) {
                const lock = state === "running" || state === "starting" || state === "stopping";
                if (lock) {
                    upload.classList.add("disabled");
                    upload.setAttribute("disabled", "true");
                } else {
                    upload.classList.remove("disabled");
                    upload.removeAttribute("disabled");
                }
            }
        },
        _reschedulePoll() {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            if (this.state === "starting" || this.state === "stopping") {
                this.pollTimer = setInterval(() => {
                    // throttledMs excludes time we spent rate-limited, so being
                    // unable to reach the server doesn't trip the failure timer.
                    if (this.transitionStartedAt && Date.now() - this.transitionStartedAt - this.throttledMs > STATUS_TRANSITION_TIMEOUT_MS) {
                        const action = this.state === "stopping" ? "stop" : "start";
                        const verb = this.state === "stopping" ? "stop" : "start";
                        Toast.show(`Server did not ${verb} within ${STATUS_TRANSITION_TIMEOUT_MS / 1000}s. Check server logs.`, "error");
                        this.setState("failed", { action });
                        return;
                    }
                    if (this.nextPollAt && Date.now() < this.nextPollAt) return; // 429 back-off
                    if (typeof fetchAndUpdateStatus === "function") {
                        fetchAndUpdateStatus();
                    }
                }, STATUS_TRANSITION_POLL_MS);
            } else if (this.state === "running" || this.state === "stopped") {
                this.pollTimer = setInterval(() => {
                    if (this.nextPollAt && Date.now() < this.nextPollAt) return; // 429 back-off
                    if (typeof fetchAndUpdateStatus === "function") {
                        fetchAndUpdateStatus();
                    }
                }, STATUS_STABLE_POLL_MS);
            }
            // failed: no poll; recoveryTimer drives the single re-fetch.
        },
        // Apply a raw `/api/v1/status` response. Honors transitional pinning:
        // while in starting/stopping, only flip out if the server reports the
        // target state. failed and stable states accept the server's word.
        applyServerStatus(rawStatus) {
            if (this.state === "starting") {
                if (rawStatus === "running") this.setState("running");
                return;
            }
            if (this.state === "stopping") {
                if (rawStatus === "stopped") this.setState("stopped");
                return;
            }
            this.setState(rawStatus);
        },
        cancelRecovery() {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = null;
        },
        // Called when a status poll comes back 429. Backs off exponentially
        // (capped) so we stop hammering, pauses the transition failure clock,
        // and tells the user once per burst.
        noteRateLimited() {
            this.pollBackoffMs = this.pollBackoffMs
                ? Math.min(this.pollBackoffMs * 2, STATUS_BACKOFF_MAX_MS)
                : STATUS_TRANSITION_POLL_MS;
            this.nextPollAt = Date.now() + this.pollBackoffMs;
            if (this.state === "starting" || this.state === "stopping") {
                this.throttledMs += this.pollBackoffMs;
            }
            if (!this.rateLimitNotified) {
                Toast.show("Status checks are rate-limited; retrying more slowly.", "error");
                this.rateLimitNotified = true;
            }
        },
        // Called after any successful status poll: clear the back-off so we
        // return to the normal cadence.
        clearRateLimit() {
            this.pollBackoffMs = 0;
            this.nextPollAt = 0;
            this.rateLimitNotified = false;
        },
        cancelAllTimers() {
            clearTimeout(this.recoveryTimer);
            clearInterval(this.pollTimer);
            this.recoveryTimer = null;
            this.pollTimer = null;
            this.transitionStartedAt = 0;
            this.throttledMs = 0;
            this.nextPollAt = 0;
            this.pollBackoffMs = 0;
            this.rateLimitNotified = false;
        },
    };

    // UploadRing: SVG progress ring overlay on #upload-button.
    // States: idle | uploading | success | error
    const UPLOAD_RING_CIRCUMFERENCE = 276.46; // 2 * pi * 44
    const UploadRing = {
        btn: null,
        progressEl: null,
        pctEl: null,
        state: "idle",
        _resetTimer: null,
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
        isBusy() {
            return this.state !== "idle";
        },
        start() {
            clearTimeout(this._resetTimer);
            this._resetTimer = null;
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
            this._resetTimer = setTimeout(() => this.reset(), 2000);
        },
        fail() {
            this.state = "error";
            this._setStateClass("error");
            this._resetTimer = setTimeout(() => this.reset(), 2000);
        },
        reset() {
            clearTimeout(this._resetTimer);
            this._resetTimer = null;
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

    // Helper function to get the Authorization header
    const getAuthHeader = () => {
        const auth = localStorage.getItem("auth");
        return auth ? `Basic ${auth}` : null;
    };

    // Helper function to handle fetch errors
    const handleFetchError = (response) => {
        if (response.status === 401) {
            localStorage.removeItem("auth");
            renderLoginUI();
            throw new Error("Unauthorized");
        }
        if (response.status === 404 && response.url.includes("state.json")) {
            alert("No state.json file found on the server.\nHas the mission been started?");
            return null;
        }
        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status}`);
        }
        return response;
    };

    // Toggle the spinning animation on the refresh button
    const toggleRefreshSpinner = (isSpinning) => {
        const refreshButton = document.getElementById("refresh-button");
        if (refreshButton) {
            refreshButton.classList.toggle("spinning", isSpinning);
        }
    };

    // Fetch and update the server status
    const fetchAndUpdateStatus = async () => {
        toggleRefreshSpinner(true);
        try {
            const response = await fetch("/api/v1/status", {
                headers: { Authorization: getAuthHeader() },
            });
            if (response.status === 429) {
                // Rate-limited: back off, but do NOT treat as a failure — we
                // simply couldn't read status this tick. The poll loop retries.
                StatusLabel.noteRateLimited();
                return;
            }
            handleFetchError(response);
            StatusLabel.clearRateLimit();
            const data = await response.json();
            updateUIWithServerStatus(data);
            serverInfo = data;
            return data;
        } catch (error) {
            console.error("Error fetching server status:", error);
        } finally {
            toggleRefreshSpinner(false);
        }
    };

    // Update the UI with server status. Defers the power button + upload
    // button class management to StatusLabel.applyServerStatus; only the
    // "allowed filenames" tooltip on the upload button is set here, since
    // it depends on data the StatusLabel doesn't see.
    const updateUIWithServerStatus = (data) => {
        const uploadButton = document.getElementById("upload-button");
        if (uploadButton) {
            uploadButton.setAttribute("data-tooltip", data.allowed_filenames.join(" "));
        }
        StatusLabel.applyServerStatus(data.status);
    };

    // Render the login UI
    const renderLoginUI = () => {
        StatusLabel.cancelAllTimers();
        fetch("/partials/login.html")
            .then((response) => response.text())
            .then((html) => {
                appContainer.innerHTML = html;

                const loginForm = document.getElementById("login-form");
                loginForm.addEventListener("submit", (event) => {
                    event.preventDefault();
                    const username = document.getElementById("username").value;
                    const password = document.getElementById("password").value;
                    localStorage.setItem("auth", btoa(`${username}:${password}`));

                    fetch("/api/v1/auth/validate", {
                        headers: { Authorization: getAuthHeader() },
                    })
                        .then(handleFetchError)
                        .then(() => renderControlUI())
                        .catch(() => {
                            alert("Invalid username or password");
                            localStorage.removeItem("auth");
                        });
                });
            })
            .catch((error) => console.error("Error loading login UI:", error));
    };

    // Render the control UI
    const renderControlUI = () => {
        StatusLabel.cancelAllTimers();
        fetch("/partials/control.html")
            .then((response) => response.text())
            .then((html) => {
                appContainer.innerHTML = html;
                setupButtonListeners();
                setTimeout(fetchAndUpdateStatus, 0); // Defer status update
            })
            .catch((error) => console.error("Error loading control UI:", error));
    };

    // Set up button event listeners
    const setupButtonListeners = () => {
        const powerButton = document.getElementById("power-button");
        const uploadButton = document.getElementById("upload-button");
        const downloadButton = document.getElementById("download-button");
        const fileInput = document.getElementById("file-input");
        const refreshButton = document.getElementById("refresh-button");

        powerButton.addEventListener("click", () => {
            // Block clicks while a transition is already in flight; the poll
            // loop is driving the eventual settle.
            if (powerButton.classList.contains("transitioning")) return;

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
                .then(async (response) => {
                    if (response.status === 401) {
                        localStorage.removeItem("auth");
                        StatusLabel.cancelAllTimers();
                        renderLoginUI();
                        const err = new Error("Unauthorized");
                        err._handled = true;
                        throw err;
                    }
                    if (!response.ok) {
                        let detail;
                        try { detail = (await response.json()).detail; } catch (_) {}
                        const err = new Error(detail || `HTTP ${response.status}`);
                        err.detail = detail;
                        throw err;
                    }
                    // 2xx: poll loop in StatusLabel will drive the settle to
                    // running/stopped once /api/v1/status reflects the change.
                    return response;
                })
                .catch((error) => {
                    if (error && error._handled) return;
                    console.error("Error toggling server power:", error);
                    StatusLabel.setState("failed", { action });
                    Toast.show(error.detail || `Failed to ${action} server`, "error");
                })
                .finally(() => toggleRefreshSpinner(false));
        });

        uploadButton.addEventListener("click", () => {
            if (uploadButton.classList.contains("disabled")) return;
            if (UploadRing.isBusy()) return;
            fileInput.click();
        });

        fileInput.addEventListener("change", () => {
            const file = fileInput.files[0];
            if (file) {
                handleFileUpload(file);
                // Reset so re-selecting the same filename fires another change event.
                fileInput.value = "";
            }
        });

        downloadButton.addEventListener("click", () => {
            toggleRefreshSpinner(true);
            fetch("/api/v1/files/state.json", {
                headers: { Authorization: getAuthHeader() },
            })
                .then(handleFetchError)
                .then((response) => response.blob())
                .then((blob) => {
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "state.json";
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    window.URL.revokeObjectURL(url);
                })
                .catch((error) => {
                    console.error("Error downloading file:", error);
                    alert("An error occurred while downloading the file.");
                })
                .finally(() => toggleRefreshSpinner(false));
        });

        refreshButton.addEventListener("click", () => {
            StatusLabel.cancelRecovery();
            fetchAndUpdateStatus();
        });
    };

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
            // If lengthComputable is false (rare with local POST), ring stays at 0%.
            // Indeterminate animation is out of scope.
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

    // Check authentication and render the appropriate UI
    const authHeader = getAuthHeader();
    if (!authHeader) {
        renderLoginUI();
    } else {
        fetch("/api/v1/auth/validate", {
            headers: { Authorization: authHeader },
        })
            .then(handleFetchError)
            .then(renderControlUI)
            .catch(renderLoginUI);
    }
});