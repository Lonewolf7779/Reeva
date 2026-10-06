// public/js/i18n.js — Centralized UI Strings and i18n Translation Foundation
"use strict";

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.Reeva = root.Reeva || {};
        root.Reeva.i18n = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    const DEFAULT_LANGUAGE = "en";
    const SUPPORTED_LANGUAGES = Object.freeze(["en"]);
    const STORAGE_KEY = "reeva_lang";

    const TRANSLATIONS = Object.freeze({
        en: Object.freeze({
            "app.title": "Reeva — Universal Reel Downloader",
            "app.heading": "Reeva — Smart, simple, and lightning-fast downloader",
            "app.subtitle": "Reeva helps you save public videos from your favorite platforms in seconds — fast, clean, and secure.",
            "platform.instagram": "Instagram",
            "platform.facebook": "Facebook",
            "platform.twitter": "Twitter (X)",
            "platform.pinterest": "Pinterest",
            "platform.youtube": "YouTube",
            "platform.generic": "More Sites",
            "platform.selected": "Selected platform: {platform}",
            "input.instruction": "Paste your link below and click Get.",
            "input.placeholder": "Paste your video link here...",
            "action.get": "Get",
            "action.download": "Download",
            "consent.label": "I confirm I own or have permission to download this content.",
            "consent.why": "Why?",
            "consent.alert": "Reeva is intended only for public content or content you own or have permission to download.",
            "consent.required": "Please check the confirmation box before downloading.",
            "status.empty_url": "⚠️ Please paste a video link first.",
            "status.fetching": "Fetching video... please wait.",
            "status.success": "✅ Video found! Click \"Download\" below.",
            "status.not_found": "⚠️ Could not find a downloadable video for this link.",
            "status.network_error": "⚠️ Network error: {message}",
            "status.generic_error": "Failed to retrieve media. Please try again.",
            "footer.disclaimer": "Disclaimer: This tool is for personal and educational use only.",
            "footer.copyright": "We never store or host media. All rights belong to their respective owners."
        })
    });

    /**
     * Resolves an input language candidate to a supported language.
     * Handles regional tags (e.g. "en-US" -> "en") and unknown candidates safely.
     *
     * @param {string|null|undefined} candidate
     * @param {readonly string[]} [supported=SUPPORTED_LANGUAGES]
     * @param {string} [fallback=DEFAULT_LANGUAGE]
     * @returns {string}
     */
    function resolveLanguage(candidate, supported = SUPPORTED_LANGUAGES, fallback = DEFAULT_LANGUAGE) {
        if (!candidate || typeof candidate !== "string") {
            return fallback;
        }

        const normalized = candidate.trim().toLowerCase();
        if (supported.includes(normalized)) {
            return normalized;
        }

        // Check primary subtag (e.g., "en-US" -> "en")
        const primaryTag = normalized.split(/[-_]/)[0];
        if (supported.includes(primaryTag)) {
            return primaryTag;
        }

        return fallback;
    }

    /**
     * Safely reads the persisted language preference from localStorage.
     *
     * @param {Storage} [storage]
     * @returns {string}
     */
    function getStoredLanguage(storage) {
        try {
            const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
            if (!store) return DEFAULT_LANGUAGE;
            const stored = store.getItem(STORAGE_KEY);
            return resolveLanguage(stored);
        } catch (_) {
            return DEFAULT_LANGUAGE;
        }
    }

    /**
     * Safely persists the non-sensitive language preference to localStorage.
     * Rejects storing anything other than a supported language identifier.
     *
     * @param {string} lang
     * @param {Storage} [storage]
     * @returns {boolean}
     */
    function setStoredLanguage(lang, storage) {
        try {
            const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
            if (!store) return false;
            const safeLang = resolveLanguage(lang);
            store.setItem(STORAGE_KEY, safeLang);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Translates a string key with optional parameter substitution.
     * Falls back to English if missing, or returns the raw key if no translation exists.
     *
     * @param {string} key
     * @param {Record<string, string|number>} [params={}]
     * @param {string} [lang=DEFAULT_LANGUAGE]
     * @returns {string}
     */
    function t(key, params = {}, lang = DEFAULT_LANGUAGE) {
        if (!key || typeof key !== "string") return "";

        const safeLang = resolveLanguage(lang);
        const langDict = TRANSLATIONS[safeLang] || TRANSLATIONS[DEFAULT_LANGUAGE] || {};
        const fallbackDict = TRANSLATIONS[DEFAULT_LANGUAGE] || {};

        let text = langDict[key] !== undefined ? langDict[key] : fallbackDict[key];
        if (text === undefined) {
            return key;
        }

        // Interpolate {param} placeholders safely
        if (params && typeof params === "object") {
            for (const [paramKey, paramVal] of Object.entries(params)) {
                const placeholder = `{${paramKey}}`;
                text = text.replaceAll(placeholder, String(paramVal));
            }
        }

        return text;
    }

    return {
        DEFAULT_LANGUAGE,
        SUPPORTED_LANGUAGES,
        TRANSLATIONS,
        resolveLanguage,
        getStoredLanguage,
        setStoredLanguage,
        t
    };
});
