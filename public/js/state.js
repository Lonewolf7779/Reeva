// public/js/state.js — Frontend State Container
"use strict";

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.Reeva = root.Reeva || {};
        root.Reeva.state = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    const SUPPORTED_PLATFORMS = Object.freeze([
        "instagram",
        "facebook",
        "twitter",
        "pinterest",
        "youtube",
        "generic"
    ]);

    const DEFAULT_PLATFORM = "instagram";

    /**
     * Creates an isolated state store instance.
     *
     * @param {object} [initialOptions={}]
     * @returns {object}
     */
    function createState(initialOptions = {}) {
        let currentPlatform = SUPPORTED_PLATFORMS.includes(initialOptions.platform)
            ? initialOptions.platform
            : DEFAULT_PLATFORM;
        let currentStatus = "idle"; // "idle" | "loading" | "success" | "error"
        let activeStreamUrl = "";
        let activeDownloadUrl = "";
        let consentGiven = false;
        let language = initialOptions.language || "en";
        let activeRequestId = 0;

        const listeners = new Set();

        function notify() {
            for (const listener of listeners) {
                try {
                    listener(getState());
                } catch (_) {}
            }
        }

        function getState() {
            return Object.freeze({
                platform: currentPlatform,
                status: currentStatus,
                activeStreamUrl,
                activeDownloadUrl,
                consentGiven,
                language,
                activeRequestId
            });
        }

        function setPlatform(platform) {
            if (!SUPPORTED_PLATFORMS.includes(platform)) return false;
            currentPlatform = platform;
            notify();
            return true;
        }

        function getPlatform() {
            return currentPlatform;
        }

        function setStatus(status) {
            currentStatus = status;
            notify();
        }

        function getStatus() {
            return currentStatus;
        }

        function setMediaUrls({ streamUrl, downloadUrl } = {}) {
            activeStreamUrl = streamUrl || "";
            activeDownloadUrl = downloadUrl || activeStreamUrl || "";
            notify();
        }

        function clearMediaUrls() {
            activeStreamUrl = "";
            activeDownloadUrl = "";
            notify();
        }

        function getStreamUrl() {
            return activeStreamUrl;
        }

        function getDownloadUrl() {
            return activeDownloadUrl;
        }

        function setConsent(given) {
            consentGiven = Boolean(given);
            notify();
        }

        function isConsentGiven() {
            return consentGiven;
        }

        function setLanguage(lang) {
            language = lang || "en";
            notify();
        }

        function getLanguage() {
            return language;
        }

        function startRequest() {
            activeRequestId += 1;
            return activeRequestId;
        }

        function isCurrentRequest(id) {
            return id === activeRequestId;
        }

        function getActiveRequestId() {
            return activeRequestId;
        }

        function reset() {
            currentStatus = "idle";
            activeStreamUrl = "";
            activeDownloadUrl = "";
            activeRequestId = 0;
            notify();
        }

        function subscribe(fn) {
            if (typeof fn === "function") {
                listeners.add(fn);
                return () => listeners.delete(fn);
            }
            return () => {};
        }

        return {
            SUPPORTED_PLATFORMS,
            DEFAULT_PLATFORM,
            getState,
            getPlatform,
            setPlatform,
            getStatus,
            setStatus,
            setMediaUrls,
            clearMediaUrls,
            getStreamUrl,
            getDownloadUrl,
            setConsent,
            isConsentGiven,
            setLanguage,
            getLanguage,
            startRequest,
            isCurrentRequest,
            getActiveRequestId,
            reset,
            subscribe
        };
    }

    // Default global singleton for standard page lifecycle
    const defaultState = createState();

    return {
        SUPPORTED_PLATFORMS,
        DEFAULT_PLATFORM,
        createState,
        defaultState
    };
});
