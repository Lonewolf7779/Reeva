// public/app.js — Frontend Application Orchestrator
"use strict";

document.addEventListener("DOMContentLoaded", () => {
    // Resolve modular dependencies from namespace
    const state = (window.Reeva && window.Reeva.state && window.Reeva.state.defaultState) || null;
    const api = (window.Reeva && window.Reeva.api) || null;
    const uiModule = (window.Reeva && window.Reeva.ui) || null;
    const i18n = (window.Reeva && window.Reeva.i18n) || null;

    if (!state || !api || !uiModule || !i18n) {
        console.error("Reeva frontend architecture dependencies failed to load.");
        return;
    }

    const ui = uiModule.createUiController(document);
    if (!ui) return;

    const { t } = i18n;
    const { elements } = ui;

    // Track active request and abort controller for race-condition prevention
    let activeAbortController = null;
    let isRequestInProgress = false;

    // =========================================================================
    // 1. Language Resolution and Initialization
    // =========================================================================
    // Resolution order:
    // 1. Stored user preference in localStorage
    // 2. Browser language (navigator.languages / navigator.language)
    // 3. English fallback
    const initialLang = i18n.resolveInitialLanguage({
        storage: typeof localStorage !== "undefined" ? localStorage : null,
        nav: typeof navigator !== "undefined" ? navigator : null
    });

    state.setLanguage(initialLang);
    ui.applyTranslations(initialLang, t, i18n.getLanguageDirection);

    // Language selector change handler
    if (elements.langSelect) {
        elements.langSelect.addEventListener("change", (e) => {
            const selectedLang = e.target.value;
            const safeLang = i18n.resolveLanguage(selectedLang, i18n.SUPPORTED_LANGUAGES, i18n.DEFAULT_LANGUAGE);

            state.setLanguage(safeLang);
            i18n.setStoredLanguage(safeLang, typeof localStorage !== "undefined" ? localStorage : null);
            ui.applyTranslations(safeLang, t, i18n.getLanguageDirection);

            // If an extraction status is currently displayed, re-render in new language
            const currentStatus = state.getStatus();
            if (currentStatus === "idle") {
                const platformLabel = t(`platform.${state.getPlatform()}`, {}, safeLang);
                ui.setLog(t("platform.selected", { platform: platformLabel }, safeLang), "info");
            } else if (currentStatus === "success") {
                ui.setLog(t("status.success", {}, safeLang), "success");
            } else if (currentStatus === "loading") {
                ui.setLoading(true, t("status.fetching", {}, safeLang));
            }
        });
    }

    // =========================================================================
    // 2. Platform Selection
    // =========================================================================
    if (elements.platformBtns) {
        elements.platformBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                const targetPlatform = btn.dataset ? btn.dataset.platform : null;
                if (!targetPlatform || !state.setPlatform(targetPlatform)) {
                    return;
                }

                ui.setActivePlatform(targetPlatform);

                const currentLang = state.getLanguage();
                const platformLabel = t(`platform.${targetPlatform}`, {}, currentLang) || targetPlatform;
                ui.setLog(t("platform.selected", { platform: platformLabel }, currentLang), "info");
            });
        });
    }

    // =========================================================================
    // 3. Consent Dialog
    // =========================================================================
    if (elements.whyConsent) {
        elements.whyConsent.addEventListener("click", (e) => {
            e.preventDefault();
            alert(t("consent.alert", {}, state.getLanguage()));
        });
    }

    // =========================================================================
    // 4. Media Extraction Trigger with Race-Condition Protection
    // =========================================================================
    async function handleGetMedia() {
        const currentLang = state.getLanguage();

        // Consent validation
        if (!ui.isConsentChecked()) {
            alert(t("consent.required", {}, currentLang));
            return;
        }

        // URL input validation
        const rawUrl = ui.getUrlInput();
        if (!rawUrl) {
            ui.setLog(t("status.empty_url", {}, currentLang), "error");
            return;
        }

        // Duplicate click guard: prevent multiple identical clicks while loading
        if (isRequestInProgress) {
            return;
        }

        // Abort any lingering previous network request
        if (activeAbortController) {
            try {
                activeAbortController.abort();
            } catch (_) {}
        }
        activeAbortController = new AbortController();

        // Increment monotonically increasing request token
        const requestId = state.startRequest();
        isRequestInProgress = true;

        // Transition UI to loading state
        state.setStatus("loading");
        state.clearMediaUrls();
        ui.setLoading(true, t("status.fetching", {}, currentLang));
        ui.hidePreview();
        ui.setDownloadButtonVisible(false);

        try {
            const result = await api.fetchMedia(state.getPlatform(), rawUrl, {
                signal: activeAbortController.signal
            });

            // If a newer request has started in the meantime, discard stale response
            if (!state.isCurrentRequest(requestId)) {
                return;
            }

            // If request was deliberately aborted by user action, ignore
            if (result.code === "ABORTED") {
                return;
            }

            // Dynamically resolve active language at render time so in-flight language changes are respected
            const renderLang = state.getLanguage();

            if (!result.success) {
                state.setStatus("error");
                const errorMessage = result.code === "NETWORK_ERROR"
                    ? t("status.network_error", { message: result.message }, renderLang)
                    : `❌ ${result.message || t("status.generic_error", {}, renderLang)}`;
                ui.setLog(errorMessage, "error");
                return;
            }

            if (!result.streamUrl) {
                state.setStatus("error");
                ui.setLog(t("status.not_found", {}, renderLang), "error");
                return;
            }

            // Media URL security validation
            if (!api.isValidMediaUrl(result.streamUrl)) {
                state.setStatus("error");
                ui.setLog(`❌ ${t("status.generic_error", {}, renderLang)}`, "error");
                return;
            }

            // Success state transition
            state.setStatus("success");
            state.setMediaUrls({
                streamUrl: result.streamUrl,
                downloadUrl: result.downloadUrl
            });

            ui.setLog(t("status.success", {}, renderLang), "success");
            ui.showPreview(result.streamUrl);
            ui.setDownloadButtonVisible(true);

        } catch (err) {
            if (!state.isCurrentRequest(requestId)) {
                return;
            }
            state.setStatus("error");
            const renderLang = state.getLanguage();
            ui.setLog(t("status.network_error", { message: err.message || "Unknown error" }, renderLang), "error");
        } finally {
            // Only restore button state if this is still the active request
            if (state.isCurrentRequest(requestId)) {
                isRequestInProgress = false;
                ui.setLoading(false);
            }
        }
    }

    if (elements.getBtn) {
        elements.getBtn.addEventListener("click", handleGetMedia);
    }

    // Keyboard accessibility: Enter in URL input triggers extraction
    if (elements.urlIn) {
        elements.urlIn.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                handleGetMedia();
            }
        });
    }

    // =========================================================================
    // 5. Download Trigger
    // =========================================================================
    if (elements.downloadBtn) {
        elements.downloadBtn.addEventListener("click", () => {
            const downloadUrl = state.getDownloadUrl();
            if (!downloadUrl) return;

            // Security check: validate media URL before calling window.open
            if (!api.isValidMediaUrl(downloadUrl)) {
                return;
            }

            window.open(downloadUrl, "_blank", "noopener,noreferrer");
        });
    }
});
