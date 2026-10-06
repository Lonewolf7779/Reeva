// public/js/i18n.js — Centralized UI Strings, Localization Engine, and Language Resolution
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
    const SUPPORTED_LANGUAGES = Object.freeze(["en", "hi"]);
    const STORAGE_KEY = "reeva_lang";

    const LANGUAGE_DIRECTIONS = Object.freeze({
        en: "ltr",
        hi: "ltr"
    });

    const TRANSLATIONS = Object.freeze({
        en: Object.freeze({
            "app.title": "Reeva — Universal Reel Downloader",
            "app.heading": "Reeva — Smart, simple, and lightning-fast downloader",
            "app.subtitle": "Reeva helps you save public videos from your favorite platforms in seconds — fast, clean, and secure.",
            "lang.label": "Language:",
            "lang.en": "English",
            "lang.hi": "हिन्दी (Hindi)",
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
            "footer.copyright": "We never store or host media. All rights belong to their respective owners.",
            "aria.video_url": "Video URL",
            "aria.media_preview": "Media preview"
        }),
        hi: Object.freeze({
            "app.title": "रीवा (Reeva) — यूनिवर्सल रील डाउनलोडर",
            "app.heading": "रीवा — सरल, तेज़ और सुरक्षित वीडियो डाउनलोडर",
            "app.subtitle": "रीवा आपको अपने पसंदीदा प्लेटफ़ॉर्म से सेकंडों में सार्वजनिक वीडियो सुरक्षित करने में मदद करता है — तेज़, साफ़ और सुरक्षित।",
            "lang.label": "भाषा:",
            "lang.en": "English",
            "lang.hi": "हिन्दी (Hindi)",
            "platform.instagram": "इंस्टाग्राम",
            "platform.facebook": "फ़ेसबुक",
            "platform.twitter": "ट्विटर (X)",
            "platform.pinterest": "पिंटरेस्ट",
            "platform.youtube": "यूट्यूब",
            "platform.generic": "अन्य साइटें",
            "platform.selected": "चयनित प्लेटफ़ॉर्म: {platform}",
            "input.instruction": "नीचे अपना लिंक पेस्ट करें और 'पाएं' पर क्लिक करें।",
            "input.placeholder": "अपना वीडियो लिंक यहाँ पेस्ट करें...",
            "action.get": "पाएं",
            "action.download": "डाउनलोड करें",
            "consent.label": "मैं पुष्टि करता/करती हूँ कि इस सामग्री का स्वामित्व या डाउनलोड करने की अनुमति मेरे पास है।",
            "consent.why": "क्यों?",
            "consent.alert": "रीवा केवल सार्वजनिक सामग्री या उस सामग्री के लिए है जिसके स्वामित्व या डाउनलोड की अनुमति आपके पास है।",
            "consent.required": "कृपया डाउनलोड करने से पहले पुष्टि बॉक्स को चेक करें।",
            "status.empty_url": "⚠️ कृपया पहले एक वीडियो लिंक पेस्ट करें।",
            "status.fetching": "वीडियो लाया जा रहा है... कृपया प्रतीक्षा करें।",
            "status.success": "✅ वीडियो मिल गया! नीचे \"डाउनलोड करें\" पर क्लिक करें।",
            "status.not_found": "⚠️ इस लिंक के लिए कोई डाउनलोड करने योग्य वीडियो नहीं मिला।",
            "status.network_error": "⚠️ नेटवर्क त्रुटि: {message}",
            "status.generic_error": "मीडिया प्राप्त करने में विफल। कृपया पुनः प्रयास करें।",
            "footer.disclaimer": "अस्वीकरण: यह उपकरण केवल व्यक्तिगत और शैक्षणिक उपयोग के लिए है।",
            "footer.copyright": "हम कभी भी मीडिया स्टोर या होस्ट नहीं करते हैं। सभी अधिकार उनके संबंधित स्वामियों के हैं।",
            "aria.video_url": "वीडियो लिंक",
            "aria.media_preview": "मीडिया पूर्वावलोकन"
        })
    });

    /**
     * Resolves an input language candidate to a supported language.
     * Handles regional tags (e.g. "en-US" -> "en", "hi-IN" -> "hi") and unknown candidates safely.
     *
     * @param {string|null|undefined} candidate
     * @param {readonly string[]} [supported=SUPPORTED_LANGUAGES]
     * @param {string|null} [fallback=DEFAULT_LANGUAGE]
     * @returns {string|null}
     */
    function resolveLanguage(candidate, supported = SUPPORTED_LANGUAGES, fallback = DEFAULT_LANGUAGE) {
        if (!candidate || typeof candidate !== "string") {
            return fallback;
        }

        const normalized = candidate.trim().toLowerCase();
        if (supported.includes(normalized)) {
            return normalized;
        }

        // Check primary subtag (e.g., "en-US" -> "en", "hi-IN" -> "hi")
        const primaryTag = normalized.split(/[-_]/)[0];
        if (supported.includes(primaryTag)) {
            return primaryTag;
        }

        return fallback;
    }

    /**
     * Detects preferred browser language from navigator object.
     *
     * @param {Navigator} [nav]
     * @returns {string|null}
     */
    function detectBrowserLanguage(nav) {
        try {
            const navObj = nav || (typeof navigator !== "undefined" ? navigator : null);
            if (!navObj) return null;

            if (Array.isArray(navObj.languages)) {
                for (const candidate of navObj.languages) {
                    const resolved = resolveLanguage(candidate, SUPPORTED_LANGUAGES, null);
                    if (resolved) return resolved;
                }
            }

            if (typeof navObj.language === "string") {
                return resolveLanguage(navObj.language, SUPPORTED_LANGUAGES, null);
            }

            return null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Safely reads the persisted language preference from localStorage.
     *
     * @param {Storage} [storage]
     * @returns {string|null}
     */
    function getStoredLanguage(storage) {
        try {
            const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
            if (!store || typeof store.getItem !== "function") return null;
            const stored = store.getItem(STORAGE_KEY);
            if (!stored || typeof stored !== "string") return null;
            return resolveLanguage(stored, SUPPORTED_LANGUAGES, null);
        } catch (_) {
            return null;
        }
    }

    /**
     * Safely persists the non-sensitive language preference to localStorage.
     * Validates and normalizes against supported languages before writing.
     *
     * @param {string} lang
     * @param {Storage} [storage]
     * @returns {boolean}
     */
    function setStoredLanguage(lang, storage) {
        try {
            const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
            if (!store || typeof store.setItem !== "function") return false;
            const safeLang = resolveLanguage(lang, SUPPORTED_LANGUAGES, null);
            if (!safeLang) return false;
            store.setItem(STORAGE_KEY, safeLang);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Determines initial language following strict precedence:
     * 1. Explicitly stored user preference
     * 2. Browser language preference
     * 3. English fallback
     *
     * @param {object} [options={}]
     * @param {Storage} [options.storage]
     * @param {Navigator} [options.nav]
     * @returns {string}
     */
    function resolveInitialLanguage(options = {}) {
        // 1. Explicitly stored user preference
        const stored = getStoredLanguage(options.storage);
        if (stored) return stored;

        // 2. Browser language preference
        const detected = detectBrowserLanguage(options.nav);
        if (detected) return detected;

        // 3. English fallback
        return DEFAULT_LANGUAGE;
    }

    /**
     * Returns writing direction for language ("ltr" or "rtl").
     *
     * @param {string} lang
     * @returns {"ltr"|"rtl"}
     */
    function getLanguageDirection(lang) {
        const safeLang = resolveLanguage(lang, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE);
        return LANGUAGE_DIRECTIONS[safeLang] || "ltr";
    }

    /**
     * Translates a string key with optional parameter substitution.
     * Fallback hierarchy: requested language key -> English key -> key itself.
     *
     * @param {string} key
     * @param {Record<string, any>} [params={}]
     * @param {string} [lang=DEFAULT_LANGUAGE]
     * @returns {string}
     */
    function t(key, params = {}, lang = DEFAULT_LANGUAGE) {
        if (!key || typeof key !== "string") return "";

        const safeLang = resolveLanguage(lang, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE);
        const langDict = TRANSLATIONS[safeLang] || {};
        const fallbackDict = TRANSLATIONS[DEFAULT_LANGUAGE] || {};

        let text = langDict[key];
        if (typeof text !== "string") {
            text = fallbackDict[key];
        }
        if (typeof text !== "string") {
            return key;
        }

        // Interpolate {param} placeholders safely without regex eval or innerHTML
        if (params && typeof params === "object") {
            for (const [paramKey, paramVal] of Object.entries(params)) {
                const placeholder = `{${paramKey}}`;
                let safeVal = "";
                if (paramVal !== null && paramVal !== undefined) {
                    if (typeof paramVal === "object") {
                        safeVal = "[object]";
                    } else {
                        safeVal = String(paramVal);
                    }
                }
                text = text.replaceAll(placeholder, () => safeVal);
            }
        }

        return text;
    }

    return {
        DEFAULT_LANGUAGE,
        SUPPORTED_LANGUAGES,
        LANGUAGE_DIRECTIONS,
        TRANSLATIONS,
        resolveLanguage,
        detectBrowserLanguage,
        getStoredLanguage,
        setStoredLanguage,
        resolveInitialLanguage,
        getLanguageDirection,
        t
    };
});
