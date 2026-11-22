// public/js/workspace.js — Creator Media Workspace Frontend Controller (Phase 3)
"use strict";

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.Reeva = root.Reeva || {};
        root.Reeva.workspace = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    const DEFAULT_MAX_UPLOAD_BYTES = 250 * 1024 * 1024; // 250 MB
    const DEFAULT_POLL_INTERVAL_MS = 1000;
    const DEFAULT_MAX_POLLS = 120;

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function createWorkspaceController(doc, options = {}) {
        if (!doc) return null;

        const api = options.api || (typeof window !== "undefined" && window.Reeva && window.Reeva.api) || null;
        if (!api) return null;

        const win = options.window || (typeof window !== "undefined" ? window : globalThis);
        const fetchFn = options.fetchFn || (win && typeof win.fetch === "function" ? win.fetch.bind(win) : null);
        const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
        const maxPolls = options.maxPolls || DEFAULT_MAX_POLLS;
        let maxUploadBytes = options.maxUploadBytes || DEFAULT_MAX_UPLOAD_BYTES;

        const el = {
            section: doc.getElementById("media-workspace"),
            availabilityNotice: doc.getElementById("workspace-availability"),
            form: doc.getElementById("workspace-form"),
            fileInput: doc.getElementById("workspace-file"),
            fileMeta: doc.getElementById("workspace-file-meta"),
            operationSelect: doc.getElementById("workspace-operation"),
            optCompress: doc.getElementById("workspace-opt-compress"),
            compressPreset: doc.getElementById("workspace-compress-preset"),
            optConvert: doc.getElementById("workspace-opt-convert"),
            convertFormat: doc.getElementById("workspace-convert-format"),
            convertRemux: doc.getElementById("workspace-convert-remux"),
            optAudio: doc.getElementById("workspace-opt-audio"),
            audioFormat: doc.getElementById("workspace-audio-format"),
            audioBitrate: doc.getElementById("workspace-audio-bitrate"),
            optTrim: doc.getElementById("workspace-opt-trim"),
            trimStart: doc.getElementById("workspace-trim-start"),
            trimEnd: doc.getElementById("workspace-trim-end"),
            trimMode: doc.getElementById("workspace-trim-mode"),
            optResize: doc.getElementById("workspace-opt-resize"),
            resizePreset: doc.getElementById("workspace-resize-preset"),
            resizeFit: doc.getElementById("workspace-resize-fit"),
            submitBtn: doc.getElementById("workspace-submit"),
            cancelBtn: doc.getElementById("workspace-cancel"),
            downloadBtn: doc.getElementById("workspace-download"),
            progressWrap: doc.getElementById("workspace-progress-wrap"),
            progressBar: doc.getElementById("workspace-progress"),
            statusBox: doc.getElementById("workspace-status")
        };

        if (!el.section || !el.form) return null;

        let isFeatureEnabled = false;
        let isBusy = false;
        let activeAbortController = null;
        let activePollTimer = null;
        // Capability token lives strictly in closure memory, never in storage or URLs
        let activeJobCredentials = null; // { jobId, capabilityToken, expiresAt }

        function setStatus(message, type = "info") {
            if (!el.statusBox) return;
            el.statusBox.textContent = message || "";
            el.statusBox.className = `workspace-status status-${type}`;
        }

        function setProgress(percent, visible) {
            if (!el.progressWrap || !el.progressBar) return;
            if (visible) {
                el.progressWrap.classList.remove("hidden");
                el.progressBar.value = Math.max(0, Math.min(100, Number(percent) || 0));
            } else {
                el.progressWrap.classList.add("hidden");
                el.progressBar.value = 0;
            }
        }

        function updateOperationPanels() {
            const op = el.operationSelect ? el.operationSelect.value : "compress";
            const panels = [
                [el.optCompress, "compress"],
                [el.optConvert, "convert"],
                [el.optAudio, "extract_audio"],
                [el.optTrim, "trim"],
                [el.optResize, "resize"]
            ];
            for (const [panel, name] of panels) {
                if (!panel) continue;
                if (op === name) {
                    panel.classList.remove("hidden");
                } else {
                    panel.classList.add("hidden");
                }
            }
        }

        function updateControlStates() {
            const disabled = !isFeatureEnabled || isBusy;
            if (el.fileInput) {
                el.fileInput.disabled = disabled;
                el.fileInput.setAttribute("aria-disabled", String(disabled));
            }
            if (el.operationSelect) {
                el.operationSelect.disabled = disabled;
            }
            if (el.submitBtn) {
                el.submitBtn.disabled = disabled;
                el.submitBtn.setAttribute("aria-disabled", String(disabled));
            }
            if (el.cancelBtn) {
                if (isBusy) {
                    el.cancelBtn.classList.remove("hidden");
                    el.cancelBtn.disabled = false;
                } else {
                    el.cancelBtn.classList.add("hidden");
                    el.cancelBtn.disabled = true;
                }
            }
        }

        function clearActiveJob() {
            if (activePollTimer) {
                clearTimeout(activePollTimer);
                activePollTimer = null;
            }
            activeJobCredentials = null;
            if (el.downloadBtn) {
                el.downloadBtn.classList.add("hidden");
                el.downloadBtn.disabled = true;
            }
        }

        function setAvailability(enabled, serverMaxBytes) {
            isFeatureEnabled = Boolean(enabled);
            if (Number.isFinite(serverMaxBytes) && serverMaxBytes > 0) {
                maxUploadBytes = serverMaxBytes;
            }

            if (isFeatureEnabled) {
                el.section.classList.remove("workspace-disabled");
                if (el.availabilityNotice) {
                    el.availabilityNotice.textContent = `Ready — upload your own audio/video up to ${formatBytes(maxUploadBytes)}.`;
                    el.availabilityNotice.className = "workspace-availability available";
                }
            } else {
                clearActiveJob();
                setProgress(0, false);
                el.section.classList.add("workspace-disabled");
                if (el.availabilityNotice) {
                    el.availabilityNotice.textContent = "Media Workspace is currently disabled on this server.";
                    el.availabilityNotice.className = "workspace-availability disabled";
                }
                setStatus("Media processing is unavailable until enabled on the server.", "info");
            }
            updateControlStates();
        }

        function collectProfileOptions() {
            const op = el.operationSelect ? el.operationSelect.value : "";
            if (op === "compress") {
                return { preset: el.compressPreset ? el.compressPreset.value : "balanced" };
            }
            if (op === "convert") {
                return {
                    format: el.convertFormat ? el.convertFormat.value : "mp4",
                    remux: Boolean(el.convertRemux && el.convertRemux.checked)
                };
            }
            if (op === "extract_audio") {
                return {
                    format: el.audioFormat ? el.audioFormat.value : "mp3",
                    bitrate: el.audioBitrate ? el.audioBitrate.value : "192k"
                };
            }
            if (op === "trim") {
                return {
                    startSeconds: el.trimStart ? el.trimStart.value : 0,
                    endSeconds: el.trimEnd ? el.trimEnd.value : "",
                    mode: el.trimMode ? el.trimMode.value : "fast_copy"
                };
            }
            if (op === "resize") {
                return {
                    preset: el.resizePreset ? el.resizePreset.value : "portrait_1080x1920",
                    fit: el.resizeFit ? el.resizeFit.value : "contain"
                };
            }
            return {};
        }

        async function pollJobStatus(jobId, capabilityToken, attempt = 0) {
            if (!activeJobCredentials || activeJobCredentials.jobId !== jobId) return;
            if (attempt >= maxPolls) {
                isBusy = false;
                updateControlStates();
                setStatus("Processing is taking longer than expected. Please try cancelling and retrying.", "error");
                return;
            }

            const res = await api.getMediaJobStatus(jobId, capabilityToken, {
                fetchFn,
                signal: activeAbortController ? activeAbortController.signal : undefined
            });

            if (!activeJobCredentials || activeJobCredentials.jobId !== jobId) return;

            if (!res.success) {
                if (res.code === "ABORTED") return;
                isBusy = false;
                updateControlStates();
                setStatus(res.message || "Failed to check processing status.", "error");
                return;
            }

            const job = res.job;
            if (job.status === "completed") {
                isBusy = false;
                setProgress(100, false);
                updateControlStates();
                if (el.downloadBtn) {
                    el.downloadBtn.classList.remove("hidden");
                    el.downloadBtn.disabled = false;
                }
                const sizeText = job.output && job.output.sizeBytes ? ` (${formatBytes(job.output.sizeBytes)})` : "";
                setStatus(`Processing complete${sizeText}. Ready to download securely.`, "success");
                return;
            }

            if (job.status === "failed") {
                isBusy = false;
                setProgress(0, false);
                clearActiveJob();
                updateControlStates();
                setStatus((job.error && job.error.message) || "Media processing failed.", "error");
                return;
            }

            if (job.status === "cancelled" || job.status === "expired") {
                isBusy = false;
                setProgress(0, false);
                clearActiveJob();
                updateControlStates();
                setStatus(job.status === "expired" ? "Processed job expired." : "Processing cancelled.", "info");
                return;
            }

            setStatus(`Processing (${job.status})...`, "info");
            activePollTimer = setTimeout(() => {
                pollJobStatus(jobId, capabilityToken, attempt + 1);
            }, pollIntervalMs);
        }

        async function handleSubmit(e) {
            if (e && typeof e.preventDefault === "function") e.preventDefault();
            if (!isFeatureEnabled) {
                setStatus("Media processing is disabled on this server.", "error");
                return;
            }
            if (isBusy) return;

            const file = el.fileInput && el.fileInput.files && el.fileInput.files[0];
            if (!file) {
                setStatus("Please choose a video or audio file first.", "error");
                return;
            }
            if (file.size <= 0) {
                setStatus("Selected file is empty.", "error");
                return;
            }
            if (file.size > maxUploadBytes) {
                setStatus(`File exceeds maximum allowed size of ${formatBytes(maxUploadBytes)}.`, "error");
                return;
            }

            const op = el.operationSelect ? el.operationSelect.value : "";
            const profileCheck = api.buildMediaProfile(op, collectProfileOptions());
            if (!profileCheck.ok) {
                setStatus(profileCheck.message || "Invalid processing settings.", "error");
                return;
            }

            clearActiveJob();
            isBusy = true;
            activeAbortController = new AbortController();
            updateControlStates();
            setProgress(0, true);
            setStatus("Uploading media securely...", "info");

            const submitRes = await api.submitMediaJob({
                file,
                profile: profileCheck.profile,
                signal: activeAbortController.signal,
                fetchFn,
                xhrFactory: options.xhrFactory,
                onProgress: (pct) => {
                    setProgress(pct, true);
                    setStatus(`Uploading media... ${pct}%`, "info");
                }
            });

            if (!submitRes.success) {
                isBusy = false;
                setProgress(0, false);
                updateControlStates();
                setStatus(submitRes.message || "Upload failed.", submitRes.code === "ABORTED" ? "info" : "error");
                return;
            }

            activeJobCredentials = {
                jobId: submitRes.job.jobId,
                capabilityToken: submitRes.capabilityToken
            };
            setProgress(100, false);
            setStatus("Upload complete. Queued for processing...", "info");
            await pollJobStatus(submitRes.job.jobId, submitRes.capabilityToken, 0);
        }

        async function handleCancel() {
            if (!isBusy && !activeJobCredentials) return;
            if (activeAbortController) {
                try { activeAbortController.abort(); } catch (_) {}
            }
            const creds = activeJobCredentials;
            clearActiveJob();
            if (creds) {
                await api.cancelMediaJob(creds.jobId, creds.capabilityToken, { fetchFn });
            }
            isBusy = false;
            setProgress(0, false);
            updateControlStates();
            setStatus("Media processing cancelled.", "info");
        }

        async function handleDownload() {
            if (!activeJobCredentials) {
                setStatus("No completed media output available.", "error");
                return;
            }
            const { jobId, capabilityToken } = activeJobCredentials;
            if (el.downloadBtn) el.downloadBtn.disabled = true;
            setStatus("Preparing secure download...", "info");

            const res = await api.fetchMediaJobOutputBlob(jobId, capabilityToken, { fetchFn });
            if (!res.success) {
                if (res.statusCode === 410 || res.code === "MEDIA_EXPIRED") {
                    clearActiveJob();
                } else if (el.downloadBtn) {
                    el.downloadBtn.disabled = false;
                }
                setStatus(res.message || "Download failed.", "error");
                return;
            }

            let objectUrl = null;
            try {
                const urlApi = (win && win.URL) || (typeof URL !== "undefined" ? URL : null);
                if (urlApi && typeof urlApi.createObjectURL === "function") {
                    objectUrl = urlApi.createObjectURL(res.blob);
                    const anchor = doc.createElement("a");
                    anchor.href = objectUrl;
                    anchor.download = res.filename || "reeva_processed_media";
                    anchor.rel = "noopener noreferrer";
                    doc.body.appendChild(anchor);
                    anchor.click();
                    anchor.remove();
                }
                setStatus("Download started.", "success");
            } finally {
                if (objectUrl && win && win.URL && typeof win.URL.revokeObjectURL === "function") {
                    win.URL.revokeObjectURL(objectUrl);
                }
                if (el.downloadBtn && activeJobCredentials) {
                    el.downloadBtn.disabled = false;
                }
            }
        }

        // Bind DOM events
        if (el.fileInput) {
            el.fileInput.addEventListener("change", () => {
                const f = el.fileInput.files && el.fileInput.files[0];
                if (el.fileMeta) {
                    el.fileMeta.textContent = f ? `${f.name} (${formatBytes(f.size)})` : "No file selected.";
                }
            });
        }
        if (el.operationSelect) {
            el.operationSelect.addEventListener("change", updateOperationPanels);
        }
        el.form.addEventListener("submit", handleSubmit);
        if (el.cancelBtn) el.cancelBtn.addEventListener("click", handleCancel);
        if (el.downloadBtn) el.downloadBtn.addEventListener("click", handleDownload);

        updateOperationPanels();
        setAvailability(false);

        return {
            setAvailability,
            handleSubmit,
            handleCancel,
            handleDownload,
            getIsEnabled: () => isFeatureEnabled,
            getIsBusy: () => isBusy,
            hasActiveCredentials: () => Boolean(activeJobCredentials)
        };
    }

    return {
        createWorkspaceController,
        formatBytes
    };
});
