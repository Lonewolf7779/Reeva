// public/js/ui.js — Safe DOM Rendering and UI State Operations
"use strict";

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.Reeva = root.Reeva || {};
        root.Reeva.ui = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    /**
     * Initializes UI controller bound to a document context.
     * Caches DOM references to avoid repeated DOM queries.
     * Uses strictly safe DOM manipulation APIs (textContent, setAttribute, classList).
     *
     * @param {Document} [doc]
     * @returns {object}
     */
    function createUiController(doc) {
        const documentRef = doc || (typeof document !== "undefined" ? document : null);
        if (!documentRef) {
            return null;
        }

        const elements = {
            getBtn: documentRef.getElementById("get"),
            downloadBtn: documentRef.getElementById("download"),
            urlIn: documentRef.getElementById("url"),
            log: documentRef.getElementById("log"),
            preview: documentRef.getElementById("preview"),
            consent: documentRef.getElementById("consent"),
            whyConsent: documentRef.getElementById("why-consent"),
            platformBtns: documentRef.querySelectorAll(".platform-btn")
        };

        // Ensure accessibility attributes on status log container
        if (elements.log) {
            elements.log.setAttribute("role", "status");
            elements.log.setAttribute("aria-live", "polite");
        }

        /**
         * Updates status log text safely using textContent.
         *
         * @param {string} message
         * @param {"info"|"success"|"error"} [type="info"]
         */
        function setLog(message, type = "info") {
            if (!elements.log) return;
            const colorMap = {
                info: "var(--muted)",
                success: "var(--success)",
                error: "var(--error)"
            };
            elements.log.style.color = colorMap[type] || "var(--muted)";
            elements.log.textContent = String(message || "");
        }

        /**
         * Clears status log text.
         */
        function clearLog() {
            if (!elements.log) return;
            elements.log.textContent = "";
        }

        /**
         * Sets loading visual state.
         *
         * @param {boolean} isLoading
         * @param {string} [loadingText]
         */
        function setLoading(isLoading, loadingText) {
            if (elements.getBtn) {
                elements.getBtn.disabled = Boolean(isLoading);
            }
            if (isLoading && loadingText) {
                setLog(loadingText, "info");
            }
        }

        /**
         * Displays the video preview element with a validated stream URL.
         *
         * @param {string} streamUrl
         */
        function showPreview(streamUrl) {
            if (!elements.preview || !streamUrl) return;
            elements.preview.src = streamUrl;
            elements.preview.style.display = "block";
        }

        /**
         * Hides and resets the video preview.
         */
        function hidePreview() {
            if (!elements.preview) return;
            try {
                if (typeof elements.preview.pause === "function") {
                    elements.preview.pause();
                }
            } catch (_) {}
            elements.preview.removeAttribute("src");
            elements.preview.style.display = "none";
        }

        /**
         * Toggles the visibility of the Download action button.
         *
         * @param {boolean} show
         */
        function setDownloadButtonVisible(show) {
            if (!elements.downloadBtn) return;
            elements.downloadBtn.style.display = show ? "inline-block" : "none";
        }

        /**
         * Highlights the selected platform button and de-highlights all others.
         * Does NOT rely on inner text of button, matches on data-platform attribute.
         *
         * @param {string} selectedPlatform
         */
        function setActivePlatform(selectedPlatform) {
            if (!elements.platformBtns) return;
            elements.platformBtns.forEach((btn) => {
                if (btn.dataset && btn.dataset.platform === selectedPlatform) {
                    btn.classList.add("active");
                } else {
                    btn.classList.remove("active");
                }
            });
        }

        /**
         * Retrieves trimmed URL input value.
         *
         * @returns {string}
         */
        function getUrlInput() {
            return elements.urlIn ? elements.urlIn.value.trim() : "";
        }

        /**
         * Checks whether consent checkbox is checked.
         *
         * @returns {boolean}
         */
        function isConsentChecked() {
            return elements.consent ? Boolean(elements.consent.checked) : false;
        }

        return {
            elements,
            setLog,
            clearLog,
            setLoading,
            showPreview,
            hidePreview,
            setDownloadButtonVisible,
            setActivePlatform,
            getUrlInput,
            isConsentChecked
        };
    }

    return {
        createUiController
    };
});
