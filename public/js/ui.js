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
            appHeading: documentRef.getElementById("app-heading"),
            appSubtitle: documentRef.getElementById("app-subtitle"),
            inputInstruction: documentRef.getElementById("input-instruction"),
            langLabel: documentRef.getElementById("lang-label"),
            langSelect: documentRef.getElementById("lang-select"),
            getBtn: documentRef.getElementById("get"),
            downloadBtn: documentRef.getElementById("download"),
            urlIn: documentRef.getElementById("url"),
            log: documentRef.getElementById("log"),
            preview: documentRef.getElementById("preview"),
            consent: documentRef.getElementById("consent"),
            consentText: documentRef.getElementById("consent-text"),
            whyConsent: documentRef.getElementById("why-consent"),
            footerDisclaimer: documentRef.getElementById("footer-disclaimer"),
            footerCopyright: documentRef.getElementById("footer-copyright"),
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
         * Sets loading visual and accessibility state.
         *
         * @param {boolean} isLoading
         * @param {string} [loadingText]
         */
        function setLoading(isLoading, loadingText) {
            if (elements.getBtn) {
                elements.getBtn.disabled = Boolean(isLoading);
                elements.getBtn.setAttribute("aria-busy", String(Boolean(isLoading)));
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
            elements.preview.classList.remove("hidden");
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
            elements.preview.classList.add("hidden");
            elements.preview.style.display = "none";
        }

        /**
         * Toggles the visibility of the Download action button.
         *
         * @param {boolean} show
         */
        function setDownloadButtonVisible(show) {
            if (!elements.downloadBtn) return;
            if (show) {
                elements.downloadBtn.classList.remove("hidden");
                elements.downloadBtn.style.display = "inline-block";
                elements.downloadBtn.setAttribute("aria-hidden", "false");
            } else {
                elements.downloadBtn.classList.add("hidden");
                elements.downloadBtn.style.display = "none";
                elements.downloadBtn.setAttribute("aria-hidden", "true");
            }
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

        /**
         * Applies active localization to the DOM elements.
         *
         * @param {string} lang
         * @param {(key: string, params?: object, lang?: string) => string} t
         * @param {(lang: string) => "ltr"|"rtl"} [getDirection]
         */
        function applyTranslations(lang, t, getDirection) {
            if (typeof t !== "function") return;

            // HTML lang & direction attributes
            if (documentRef.documentElement) {
                documentRef.documentElement.lang = lang;
                if (typeof getDirection === "function") {
                    documentRef.documentElement.dir = getDirection(lang);
                }
            }

            // Document title
            const titleText = t("app.title", {}, lang);
            if (titleText) {
                documentRef.title = titleText;
            }

            // Headers & instructions
            if (elements.appHeading) elements.appHeading.textContent = t("app.heading", {}, lang);
            if (elements.appSubtitle) elements.appSubtitle.textContent = t("app.subtitle", {}, lang);
            if (elements.inputInstruction) elements.inputInstruction.textContent = t("input.instruction", {}, lang);
            if (elements.langLabel) elements.langLabel.textContent = t("lang.label", {}, lang);

            // Controls & accessibility labels
            if (elements.urlIn) {
                elements.urlIn.placeholder = t("input.placeholder", {}, lang);
                elements.urlIn.setAttribute("aria-label", t("aria.video_url", {}, lang));
            }
            if (elements.getBtn) elements.getBtn.textContent = t("action.get", {}, lang);
            if (elements.downloadBtn) elements.downloadBtn.textContent = t("action.download", {}, lang);

            // Consent & media labels
            if (elements.consentText) elements.consentText.textContent = t("consent.label", {}, lang);
            if (elements.whyConsent) elements.whyConsent.textContent = t("consent.why", {}, lang);
            if (elements.preview) elements.preview.setAttribute("aria-label", t("aria.media_preview", {}, lang));

            // Footer text
            if (elements.footerDisclaimer) elements.footerDisclaimer.textContent = t("footer.disclaimer", {}, lang);
            if (elements.footerCopyright) elements.footerCopyright.textContent = t("footer.copyright", {}, lang);

            // Platform buttons
            if (elements.platformBtns) {
                elements.platformBtns.forEach((btn) => {
                    const platform = btn.dataset ? btn.dataset.platform : null;
                    if (platform) {
                        btn.textContent = t(`platform.${platform}`, {}, lang);
                    }
                });
            }

            // Language selector select value
            if (elements.langSelect) {
                elements.langSelect.value = lang;
            }
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
            isConsentChecked,
            applyTranslations
        };
    }

    return {
        createUiController
    };
});
