// public/app.js — Frontend Application Orchestrator
"use strict";

const EXPECTED_PLATFORMS = Object.freeze([
    "instagram",
    "facebook",
    "twitter",
    "pinterest",
    "youtube",
    "tiktok",
    "generic"
]);

function createAppController(options = {}) {
    const win = options.window || (typeof window !== "undefined" ? window : globalThis);
    const doc = options.document || (typeof document !== "undefined" ? document : null);
    const state = options.state || (win && win.Reeva && win.Reeva.state && win.Reeva.state.defaultState) || null;
    const api = options.api || (win && win.Reeva && win.Reeva.api) || null;
    const uiModule = options.uiModule || (win && win.Reeva && win.Reeva.ui) || null;
    const i18n = options.i18n || (win && win.Reeva && win.Reeva.i18n) || null;
    const fetchFn = options.fetchFn || (win && typeof win.fetch === "function" ? win.fetch.bind(win) : (typeof fetch === "function" ? fetch : null));

    if (!doc || !state || !api || !uiModule || !i18n) {
        if (typeof console !== "undefined" && console.error) {
            console.error("Reeva frontend architecture dependencies failed to load.");
        }
        return null;
    }

    const ui = uiModule.createUiController(doc);
    if (!ui) return null;

    const { t } = i18n;
    const { elements } = ui;

    // Track active request and abort controller for race-condition prevention
    let activeAbortController = null;
    let isRequestInProgress = false;

    // Availability and capability state tracking
    let capabilitiesLoaded = false;
    let verifiedPlatforms = null;
    let verifiedEmbedPlatforms = ["tiktok", "instagram", "facebook"];

    // Platform selection must be prevented before capabilities load.
    // Clear initial state platform and disable submission and platform buttons pending verification.
    if (typeof state.clearPlatform === "function") {
        state.clearPlatform();
    }

    if (elements.getBtn) {
        elements.getBtn.disabled = true;
        elements.getBtn.setAttribute("aria-disabled", "true");
    }

    if (elements.platformBtns) {
        elements.platformBtns.forEach((btn) => {
            btn.disabled = true;
            btn.setAttribute("aria-disabled", "true");
            btn.classList.add("disabled");
            btn.classList.remove("active");
            btn.setAttribute("title", "Checking service availability...");
        });
    }
    ui.setActivePlatform("");

    // =========================================================================
    // 1. Language Resolution and Initialization
    // =========================================================================
    const initialLang = i18n.resolveInitialLanguage({
        storage: win && typeof win.localStorage !== "undefined" ? win.localStorage : (typeof localStorage !== "undefined" ? localStorage : null),
        nav: win && typeof win.navigator !== "undefined" ? win.navigator : (typeof navigator !== "undefined" ? navigator : null)
    });

    state.setLanguage(initialLang);
    ui.applyTranslations(initialLang, t, i18n.getLanguageDirection);

    // =========================================================================
    // 0. Interactive Anime Companion Initialization
    // =========================================================================
    let companion = null;
    const companionLib = (win && win.ReevaCompanion) || (typeof ReevaCompanion !== "undefined" ? ReevaCompanion : null);
    if (companionLib && typeof companionLib.initCompanion === "function") {
        companion = companionLib.initCompanion("companion-stage", { initialLanguage: initialLang }) ||
                    companionLib.initCompanion("anime-companion-root", { initialLanguage: initialLang });
        if (companion) {
            setTimeout(() => {
                companion.triggerState(companionLib.STATES.WELCOME, 4000);
            }, 600);
        }
    }

    if (elements.langSelect) {
        elements.langSelect.addEventListener("change", (e) => {
            const selectedLang = e.target.value;
            const safeLang = i18n.resolveLanguage(selectedLang, i18n.SUPPORTED_LANGUAGES, i18n.DEFAULT_LANGUAGE);

            state.setLanguage(safeLang);
            if (companion) {
                companion.setLanguage(safeLang);
            }
            i18n.setStoredLanguage(
                safeLang,
                win && typeof win.localStorage !== "undefined" ? win.localStorage : (typeof localStorage !== "undefined" ? localStorage : null)
            );
            ui.applyTranslations(safeLang, t, i18n.getLanguageDirection);

            const currentStatus = state.getStatus();
            if (currentStatus === "idle") {
                const activePlat = state.getPlatform();
                if (activePlat && verifiedPlatforms && verifiedPlatforms[activePlat] === true) {
                    const platformLabel = t(`platform.${activePlat}`, {}, safeLang) || activePlat;
                    ui.setLog(t("platform.selected", { platform: platformLabel }, safeLang), "info");
                }
            } else if (currentStatus === "success") {
                ui.setLog(t("status.success", {}, safeLang), "success");
            } else if (currentStatus === "loading") {
                ui.setLoading(true, t("status.fetching", {}, safeLang));
            }
        });
    }

    // =========================================================================
    // 2. Platform Selection Event Listeners
    // =========================================================================
    if (elements.platformBtns) {
        elements.platformBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                if (!capabilitiesLoaded || !verifiedPlatforms || btn.disabled || btn.getAttribute("aria-disabled") === "true") {
                    return;
                }
                const targetPlatform = btn.dataset ? btn.dataset.platform : null;
                if (!targetPlatform || verifiedPlatforms[targetPlatform] !== true) {
                    return;
                }
                const previousPlatform = state.getPlatform();
                if (!state.setPlatform(targetPlatform)) {
                    return;
                }

                // If platform changed, reset stale previews, embeds, and download buttons
                if (previousPlatform !== targetPlatform) {
                    if (isRequestInProgress && activeAbortController) {
                        try {
                            activeAbortController.abort();
                        } catch (_) {}
                        isRequestInProgress = false;
                        ui.setLoading(false);
                    }
                    state.clearMediaUrls();
                    state.setStatus("idle");
                    ui.hidePreview();
                    if (typeof ui.hideEmbed === "function") {
                        ui.hideEmbed();
                    }
                    ui.setDownloadButtonVisible(false);
                }

                ui.setActivePlatform(targetPlatform);
                if (companion && companionLib) {
                    companion.triggerState(companionLib.STATES.PLATFORM_SELECTED, 3500);
                }

                if (elements.getBtn && !isRequestInProgress) {
                    elements.getBtn.disabled = false;
                    elements.getBtn.removeAttribute("aria-disabled");
                }

                const currentLang = state.getLanguage();
                const platformLabel = t(`platform.${targetPlatform}`, {}, currentLang) || targetPlatform;
                ui.setLog(t("platform.selected", { platform: platformLabel }, currentLang), "info");
            });
        });
    }

    // =========================================================================
    // 3. Capabilities Resolution
    // =========================================================================
    async function loadCapabilities() {
        if (!fetchFn) {
            capabilitiesLoaded = false;
            verifiedPlatforms = null;
            if (typeof state.clearPlatform === "function") {
                state.clearPlatform();
            }
            if (elements.getBtn) {
                elements.getBtn.disabled = true;
                elements.getBtn.setAttribute("aria-disabled", "true");
            }
            if (elements.platformBtns) {
                elements.platformBtns.forEach((btn) => {
                    btn.disabled = true;
                    btn.setAttribute("aria-disabled", "true");
                    btn.classList.add("disabled");
                    btn.classList.remove("active");
                    btn.setAttribute("title", "Service capabilities unavailable.");
                });
            }
            ui.setActivePlatform("");
            ui.setLog("Unable to verify available services. Please refresh to try again.", "error");
            return false;
        }

        try {
            const res = await fetchFn("/api/capabilities");
            if (!res || !res.ok) {
                throw new Error(`Capabilities request failed: HTTP ${res ? res.status : "unknown"}`);
            }
            const data = await res.json();
            const caps = data && data.capabilities ? data.capabilities : null;
            if (
                !caps ||
                typeof caps !== "object" ||
                Array.isArray(caps) ||
                typeof caps.audioOnly !== "boolean" ||
                !caps.platforms ||
                typeof caps.platforms !== "object" ||
                Array.isArray(caps.platforms)
            ) {
                throw new Error("Invalid capabilities payload received.");
            }

            for (const plat of EXPECTED_PLATFORMS) {
                if (typeof caps.platforms[plat] !== "boolean") {
                    throw new Error(`Invalid or missing boolean flag for platform: ${plat}`);
                }
            }

            capabilitiesLoaded = true;
            verifiedPlatforms = caps.platforms;
            if (Array.isArray(caps.embedPlatforms)) {
                verifiedEmbedPlatforms = caps.embedPlatforms;
            }

            let firstAvailable = null;
            if (elements.platformBtns) {
                elements.platformBtns.forEach((btn) => {
                    const plat = btn.dataset ? btn.dataset.platform : null;
                    if (plat && verifiedPlatforms[plat] === true) {
                        btn.disabled = false;
                        btn.removeAttribute("aria-disabled");
                        btn.classList.remove("disabled");
                        btn.removeAttribute("title");
                        if (!firstAvailable) {
                            firstAvailable = plat;
                        }
                    } else {
                        btn.disabled = true;
                        btn.setAttribute("aria-disabled", "true");
                        btn.classList.add("disabled");
                        btn.classList.remove("active");
                        btn.setAttribute("title", "This platform is currently disabled.");
                    }
                });
            }

            if (firstAvailable) {
                state.setPlatform(firstAvailable);
                ui.setActivePlatform(firstAvailable);
                if (elements.getBtn && !isRequestInProgress) {
                    elements.getBtn.disabled = false;
                    elements.getBtn.removeAttribute("aria-disabled");
                }
                const currentLang = state.getLanguage();
                const platformLabel = t(`platform.${firstAvailable}`, {}, currentLang) || firstAvailable;
                ui.setLog(t("platform.selected", { platform: platformLabel }, currentLang), "info");
            } else {
                if (typeof state.clearPlatform === "function") {
                    state.clearPlatform();
                }
                ui.setActivePlatform("");
                if (elements.getBtn) {
                    elements.getBtn.disabled = true;
                    elements.getBtn.setAttribute("aria-disabled", "true");
                }
                ui.setLog("All platform integrations are currently disabled.", "error");
            }
            return true;
        } catch (_) {
            capabilitiesLoaded = false;
            verifiedPlatforms = null;
            if (typeof state.clearPlatform === "function") {
                state.clearPlatform();
            }
            if (elements.getBtn) {
                elements.getBtn.disabled = true;
                elements.getBtn.setAttribute("aria-disabled", "true");
            }
            if (elements.platformBtns) {
                elements.platformBtns.forEach((btn) => {
                    btn.disabled = true;
                    btn.setAttribute("aria-disabled", "true");
                    btn.classList.add("disabled");
                    btn.classList.remove("active");
                    btn.setAttribute("title", "Service capabilities unavailable.");
                });
            }
            ui.setActivePlatform("");
            ui.setLog("Unable to verify available services. Please refresh to try again.", "error");
            return false;
        }
    }

    // Safely invoke capabilities probe
    const capabilitiesPromise = loadCapabilities();

    // =========================================================================
    // Theme Toggle Handler
    // =========================================================================
    const themeBtn = doc.getElementById ? doc.getElementById("theme-toggle") : null;
    if (themeBtn) {
        try {
            const storedTheme = win && win.localStorage && typeof win.localStorage.getItem === "function"
                ? win.localStorage.getItem("reeva_theme")
                : null;
            if (storedTheme === "dark" && doc.documentElement && typeof doc.documentElement.setAttribute === "function") {
                doc.documentElement.setAttribute("data-theme", "dark");
            }
        } catch (_) {}

        themeBtn.addEventListener("click", () => {
            try {
                const currentTheme = doc.documentElement && typeof doc.documentElement.getAttribute === "function"
                    ? doc.documentElement.getAttribute("data-theme")
                    : null;
                const newTheme = currentTheme === "dark" ? "light" : "dark";
                if (doc.documentElement) {
                    if (newTheme === "dark" && typeof doc.documentElement.setAttribute === "function") {
                        doc.documentElement.setAttribute("data-theme", "dark");
                    } else if (typeof doc.documentElement.removeAttribute === "function") {
                        doc.documentElement.removeAttribute("data-theme");
                    }
                }
                if (win && win.localStorage && typeof win.localStorage.setItem === "function") {
                    win.localStorage.setItem("reeva_theme", newTheme);
                }
            } catch (_) {}
        });
    }

    // =========================================================================
    // 4. Consent Dialog
    // =========================================================================
    if (elements.whyConsent) {
        elements.whyConsent.addEventListener("click", (e) => {
            e.preventDefault();
            const alertFn = (win && typeof win.alert === "function") ? win.alert : (typeof alert === "function" ? alert : null);
            if (alertFn) {
                alertFn(t("consent.alert", {}, state.getLanguage()));
            }
        });
    }

    // =========================================================================
    // 5. Media Extraction Trigger with Complete Capability Guards
    // =========================================================================
    async function handleGetMedia() {
        const currentLang = state.getLanguage();

        // 1. Availability validation: Capabilities must be successfully verified
        if (!capabilitiesLoaded || !verifiedPlatforms) {
            ui.setLog("Unable to verify available services. Please refresh to try again.", "error");
            return;
        }

        // 2. Selected platform validation: Platform must be selected and explicitly enabled
        const activePlatform = state.getPlatform();
        if (!activePlatform || verifiedPlatforms[activePlatform] !== true) {
            const hasAnyEnabled = Object.values(verifiedPlatforms).some((v) => v === true);
            if (!hasAnyEnabled) {
                ui.setLog("All platform integrations are currently disabled.", "error");
            } else {
                ui.setLog("This platform is currently disabled.", "error");
            }
            return;
        }

        // 3. Consent validation
        if (!ui.isConsentChecked()) {
            const alertFn = (win && typeof win.alert === "function") ? win.alert : (typeof alert === "function" ? alert : null);
            if (alertFn) {
                alertFn(t("consent.required", {}, currentLang));
            }
            return;
        }

        // 4. URL input validation
        const rawUrl = ui.getUrlInput();
        if (!rawUrl) {
            if (companion && companionLib) {
                companion.triggerState(companionLib.STATES.INVALID_URL, 4200);
            }
            ui.setLog(t("status.empty_url", {}, currentLang), "error");
            return;
        }

        // 5. Duplicate click guard: prevent multiple identical clicks while loading
        if (isRequestInProgress) {
            return;
        }

        // 6. Abort any lingering previous network request
        if (activeAbortController) {
            try {
                activeAbortController.abort();
            } catch (_) {}
        }
        activeAbortController = new AbortController();

        // 7. Increment monotonically increasing request token
        const requestId = state.startRequest();
        isRequestInProgress = true;

        // Transition UI to loading state
        state.setStatus("loading");
        state.clearMediaUrls();
        if (companion && companionLib) {
            companion.triggerState(companionLib.STATES.PROCESSING);
        }
        ui.setLoading(true, t("status.fetching", {}, currentLang));
        ui.hidePreview();
        if (typeof ui.hideEmbed === "function") {
            ui.hideEmbed();
        }
        ui.setDownloadButtonVisible(false);

        try {
            const result = await api.fetchMedia(activePlatform, rawUrl, {
                signal: activeAbortController.signal,
                fetchFn
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
                // If the active platform is in verifiedEmbedPlatforms, attempt official embed resolution fallback
                if (verifiedEmbedPlatforms.includes(activePlatform) && typeof api.fetchEmbed === "function") {
                    try {
                        const embedResult = await api.fetchEmbed(activePlatform, rawUrl, {
                            signal: activeAbortController.signal,
                            fetchFn
                        });

                        if (!state.isCurrentRequest(requestId)) {
                            return;
                        }

                        if (embedResult.code === "ABORTED") {
                            return;
                        }

                        if (embedResult.success && embedResult.embed && typeof ui.showEmbed === "function") {
                            state.setStatus("success");
                            if (companion && companionLib) {
                                companion.triggerState(companionLib.STATES.SUCCESS, 5000);
                            }
                            state.clearMediaUrls();
                            ui.hidePreview();
                            ui.setDownloadButtonVisible(false);
                            ui.showEmbed(embedResult.embed);
                            ui.setLog(t("status.embed_success", {}, renderLang), "info");
                            return;
                        }
                    } catch (_) {}
                }

                state.setStatus("error");
                if (companion && companionLib) {
                    if (result.code === "NETWORK_ERROR") {
                        companion.triggerState(companionLib.STATES.NETWORK_ERROR, 4500);
                    } else if (result.code === "INVALID_URL" || result.code === "DISALLOWED_DOMAIN") {
                        companion.triggerState(companionLib.STATES.INVALID_URL, 4500);
                    } else {
                        companion.triggerState(companionLib.STATES.FAILURE, 5500);
                    }
                }
                const errorMessage = result.code === "NETWORK_ERROR"
                    ? t("status.network_error", { message: result.message }, renderLang)
                    : `❌ ${result.message || t("status.generic_error", {}, renderLang)}`;
                ui.setLog(errorMessage, "error");
                return;
            }

            if (!result.streamUrl) {
                state.setStatus("error");
                if (companion && companionLib) {
                    companion.triggerState(companionLib.STATES.FAILURE, 5500);
                }
                ui.setLog(t("status.not_found", {}, renderLang), "error");
                return;
            }

            // Media URL security validation
            if (!api.isValidMediaUrl(result.streamUrl)) {
                state.setStatus("error");
                if (companion && companionLib) {
                    companion.triggerState(companionLib.STATES.FAILURE, 5500);
                }
                ui.setLog(`❌ ${t("status.generic_error", {}, renderLang)}`, "error");
                return;
            }

            // Success state transition
            state.setStatus("success");
            if (companion && companionLib) {
                companion.triggerState(companionLib.STATES.SUCCESS, 5000);
            }
            state.setMediaUrls({
                streamUrl: result.streamUrl,
                downloadUrl: result.downloadUrl
            });

            if (typeof ui.hideEmbed === "function") {
                ui.hideEmbed();
            }
            ui.setLog(t("status.success", {}, renderLang), "success");
            ui.showPreview(result.streamUrl);
            ui.setDownloadButtonVisible(true);

        } catch (err) {
            if (!state.isCurrentRequest(requestId)) {
                return;
            }
            state.setStatus("error");
            if (companion && companionLib) {
                companion.triggerState(companionLib.STATES.NETWORK_ERROR, 4500);
            }
            const renderLang = state.getLanguage();
            ui.setLog(t("status.network_error", { message: err.message || "Unknown error" }, renderLang), "error");
        } finally {
            if (state.isCurrentRequest(requestId)) {
                isRequestInProgress = false;
                ui.setLoading(false);
                const activePlat = state.getPlatform();
                if (elements.getBtn && (!capabilitiesLoaded || !verifiedPlatforms || !activePlat || verifiedPlatforms[activePlat] !== true)) {
                    elements.getBtn.disabled = true;
                    elements.getBtn.setAttribute("aria-disabled", "true");
                }
            }
        }
    }

    if (elements.getBtn) {
        elements.getBtn.addEventListener("click", handleGetMedia);
    }

    if (elements.urlIn) {
        elements.urlIn.addEventListener("focus", () => {
            if (companion && companionLib && state.getStatus() === "idle") {
                companion.triggerState(companionLib.STATES.CURIOUS, 3500);
            }
        });
        elements.urlIn.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                handleGetMedia();
            }
        });
    }

    // =========================================================================
    // 6. Download Trigger
    // =========================================================================
    if (elements.downloadBtn) {
        elements.downloadBtn.addEventListener("click", () => {
            const downloadUrl = state.getDownloadUrl();
            if (!downloadUrl) return;

            if (!api.isValidMediaUrl(downloadUrl)) {
                return;
            }

            const openFn = (win && typeof win.open === "function") ? win.open : (typeof window !== "undefined" && window.open ? window.open : null);
            if (openFn) {
                openFn(downloadUrl, "_blank", "noopener,noreferrer");
            }
        });
    }

    return {
        handleGetMedia,
        loadCapabilities,
        capabilitiesPromise,
        getCapabilitiesLoaded: () => capabilitiesLoaded,
        getVerifiedPlatforms: () => verifiedPlatforms,
        getCompanion: () => companion,
        elements,
        state,
        ui
    };
}

if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", () => {
        const app = createAppController();
        if (typeof window !== "undefined") {
            window.__reevaApp = app;
        }
    });
}

if (typeof module === "object" && module.exports) {
    module.exports = { createAppController, EXPECTED_PLATFORMS };
} else if (typeof window !== "undefined") {
    window.Reeva = window.Reeva || {};
    window.Reeva.app = { createAppController, EXPECTED_PLATFORMS };
}
