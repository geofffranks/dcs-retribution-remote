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

    // StatusLabel: derives Server Status text + color class.
    // States: running | stopped | starting | stopping | failed
    // Transitional/failed states wired to power button in Task 3.
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
        cancelRecovery() {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = null;
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
            handleFetchError(response);
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

    // Render the login UI
    const renderLoginUI = () => {
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

        uploadButton.addEventListener("click", () => {
            if (uploadButton.classList.contains("disabled")) return;
            if (UploadRing.isBusy()) return;
            fileInput.click();
        });

        fileInput.addEventListener("change", () => {
            const file = fileInput.files[0];
            if (file) {
                handleFileUpload(file);
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