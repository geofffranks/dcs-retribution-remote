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
        } finally {``
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
        } else {
            powerButton.classList.replace("on", "off");
            powerButton.setAttribute("data-tooltip", "Start Server");
            uploadButton.classList.remove("disabled");
            uploadButton.removeAttribute("disabled");
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
            const action = isOn ? "/api/v1/server/stop" : "/api/v1/server/start";

            toggleRefreshSpinner(true);
            fetch(action, {
                method: "POST",
                headers: { Authorization: getAuthHeader() },
            })
                .then(handleFetchError)
                .then(fetchAndUpdateStatus)
                .catch((error) => console.error("Error toggling server power:", error))
                .finally(() => toggleRefreshSpinner(false));
        });

        uploadButton.addEventListener("click", () => {
            if (!uploadButton.classList.contains("disabled")) {
                fileInput.click();
            }
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

        refreshButton.addEventListener("click", fetchAndUpdateStatus);
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

        toggleRefreshSpinner(true);
        fetch("/api/v1/files/upload_miz", {
            method: "POST",
            body: formData,
            headers: { Authorization: getAuthHeader() },
        })
            .then(handleFetchError)
            .then(fetchAndUpdateStatus)
            .catch((error) => {
                console.error("Error uploading file:", error);
                alert("An error occurred while uploading the file.");
            })
            .finally(() => toggleRefreshSpinner(false));
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