// public/app.js — Frontend Application Orchestrator
"use strict";

document.addEventListener("DOMContentLoaded", () => {
    // Resolve modular dependencies (with fallback to global namespace)
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

    // Load persisted or preferred language
    const lang = i18n.getStoredLanguage();
    state.setLanguage(lang);

    // =========================================================================
    // 1. Platform Selection
    // =========================================================================
    if (elements.platformBtns) {
        elements.platformBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                const targetPlatform = btn.dataset.platform;
                if (!targetPlatform || !state.setPlatform(targetPlatform)) {
                    return;
                }

                ui.setActivePlatform(targetPlatform);

                const platformLabel = t(`platform.${targetPlatform}`, {}, state.getLanguage()) || targetPlatform;
                ui.setLog(t("platform.selected", { platform: platformLabel }, state.getLanguage()), "info");
            });
        });
    }

    // =========================================================================
    // 2. Consent Dialog
    // =========================================================================
    if (elements.whyConsent) {
        elements.whyConsent.addEventListener("click", (e) => {
            e.preventDefault();
            alert(t("consent.alert", {}, state.getLanguage()));
        });
    }

    // =========================================================================
    // 3. Media Extraction Trigger
    // =========================================================================
    async function handleGetMedia() {
        const currentLang = state.getLanguage();

        if (!ui.isConsentChecked()) {
            alert(t("consent.required", {}, currentLang));
            return;
        }

        const rawUrl = ui.getUrlInput();
        if (!rawUrl) {
            ui.setLog(t("status.empty_url", {}, currentLang), "error");
            return;
        }

        // Transition to loading state
        state.setStatus("loading");
        state.clearMediaUrls();
        ui.setLoading(true, t("status.fetching", {}, currentLang));
        ui.hidePreview();
        ui.setDownloadButtonVisible(false);

        const result = await api.fetchMedia(state.getPlatform(), rawUrl);

        ui.setLoading(false);

        if (!result.success) {
            state.setStatus("error");
            const errorMessage = result.code === "NETWORK_ERROR"
                ? t("status.network_error", { message: result.message }, currentLang)
                : `❌ ${result.message || t("status.generic_error", {}, currentLang)}`;
            ui.setLog(errorMessage, "error");
            return;
        }

        if (!result.streamUrl) {
            state.setStatus("error");
            ui.setLog(t("status.not_found", {}, currentLang), "error");
            return;
        }

        // Success state
        state.setStatus("success");
        state.setMediaUrls({
            streamUrl: result.streamUrl,
            downloadUrl: result.downloadUrl
        });

        ui.setLog(t("status.success", {}, currentLang), "success");
        ui.showPreview(result.streamUrl);
        ui.setDownloadButtonVisible(true);
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
    // 4. Download Trigger
    // =========================================================================
    if (elements.downloadBtn) {
        elements.downloadBtn.addEventListener("click", () => {
            const downloadUrl = state.getDownloadUrl();
            if (!downloadUrl) return;
            window.open(downloadUrl, "_blank", "noopener,noreferrer");
        });
    }
});
