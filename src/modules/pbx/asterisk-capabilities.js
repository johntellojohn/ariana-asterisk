const ANSWER_MODES = ["auto", "ari_media", "sip_bridge", "extension"];
const MINIMUM_ARI_EXTERNAL_MEDIA_VERSION = "16.6.0";

function normalizeAnswerMode(value, fallback = "auto") {
    const clean = String(value ?? "").trim().toLowerCase();

    if (!clean) {
        return fallback;
    }

    if (["browser", "webrtc", "ari", "external_media"].includes(clean)) {
        return "ari_media";
    }

    if (["sip-bridge", "bridge"].includes(clean)) {
        return "sip_bridge";
    }

    if (ANSWER_MODES.includes(clean)) {
        return clean;
    }

    return fallback;
}

function parseAsteriskVersion(rawVersion) {
    if (rawVersion === undefined || rawVersion === null) {
        return {
            raw: null,
            parsedVersion: null,
            major: null,
            minor: null,
            patch: null,
            detected: false,
        };
    }

    const raw = String(rawVersion).trim();
    if (!raw) {
        return {
            raw: null,
            parsedVersion: null,
            major: null,
            minor: null,
            patch: null,
            detected: false,
        };
    }

    // Supports "Asterisk 13.30.0 ...", "13.22.0", "certified/13.21-cert6", "Asterisk GIT-18-..."
    const semverMatch = raw.match(/(?:Asterisk\s+|certified\/)?(\d+)\.(\d+)(?:\.(\d+))?/i);
    if (semverMatch) {
        const major = Number(semverMatch[1]);
        const minor = Number(semverMatch[2]);
        const patch = semverMatch[3] !== undefined ? Number(semverMatch[3]) : 0;

        if (Number.isFinite(major) && Number.isFinite(minor)) {
            return {
                raw,
                parsedVersion: `${major}.${minor}.${Number.isFinite(patch) ? patch : 0}`,
                major,
                minor,
                patch: Number.isFinite(patch) ? patch : 0,
                detected: true,
            };
        }
    }

    const majorOnlyMatch = raw.match(/(?:Asterisk\s+|GIT-)(\d{2})(?:[^\d]|$)/i);
    if (majorOnlyMatch) {
        const major = Number(majorOnlyMatch[1]);
        if (Number.isFinite(major)) {
            return {
                raw,
                parsedVersion: `${major}.0.0`,
                major,
                minor: 0,
                patch: 0,
                detected: true,
            };
        }
    }

    return {
        raw,
        parsedVersion: null,
        major: null,
        minor: null,
        patch: null,
        detected: false,
    };
}

function supportsExternalMediaVersion(versionInput) {
    const parsed =
        versionInput && typeof versionInput === "object" && "major" in versionInput
            ? versionInput
            : parseAsteriskVersion(versionInput);

    if (!parsed.detected || parsed.major === null || parsed.minor === null) {
        return null;
    }

    return parsed.major > 16 || (parsed.major === 16 && parsed.minor >= 6);
}

function buildCapabilitiesSnapshot({
    rawVersion = null,
    versionSource = null,
    detectedAt = null,
    configuredAnswerMode = "auto",
    sipBridgeAvailable = false,
} = {}) {
    const parsed = parseAsteriskVersion(rawVersion);
    const supportsExternalMedia = supportsExternalMediaVersion(parsed);
    const configured = normalizeAnswerMode(configuredAnswerMode, "auto");

    let recommendedAnswerMode = null;
    let effectiveAnswerMode = configured;
    let compatibilityWarning = null;
    let compatibilityLabel = "Versión Asterisk pendiente de detección";

    if (supportsExternalMedia === true) {
        recommendedAnswerMode = "ari_media";
        effectiveAnswerMode = configured === "auto" ? "ari_media" : configured;
        compatibilityLabel = `Asterisk ${parsed.parsedVersion} (>= 16.6): ARI externalMedia nativo compatible`;
    } else if (supportsExternalMedia === false) {
        recommendedAnswerMode = sipBridgeAvailable ? "sip_bridge" : "extension";
        effectiveAnswerMode = configured === "auto" ? recommendedAnswerMode : configured;

        if (configured === "ari_media") {
            compatibilityWarning = `Asterisk ${parsed.parsedVersion} (< 16.6) no soporta /ari/channels/externalMedia. Cambia pbxAnswerMode a auto, extension (MicroSIP) o sip_bridge.`;
        } else if (configured === "sip_bridge" && !sipBridgeAvailable) {
            compatibilityWarning = `Modo sip_bridge configurado para Asterisk ${parsed.parsedVersion}; requiere bridge headless SIP activo (Fase 4B.2).`;
        }

        compatibilityLabel = sipBridgeAvailable
            ? `Asterisk ${parsed.parsedVersion} (< 16.6): usar sip_bridge o extension`
            : `Asterisk ${parsed.parsedVersion} (< 16.6): sin externalMedia ARI — recomendado extension (MicroSIP) o sip_bridge`;
    } else if (configured === "auto") {
        effectiveAnswerMode = "auto";
    }

    const compatibleWithConfiguredMode =
        supportsExternalMedia === null
            ? true
            : effectiveAnswerMode === "ari_media"
              ? supportsExternalMedia === true
              : true;

    return {
        asteriskVersion: parsed.parsedVersion,
        asteriskRawVersion: parsed.raw,
        asteriskMajor: parsed.major,
        asteriskMinor: parsed.minor,
        asteriskPatch: parsed.patch,
        versionDetected: parsed.detected,
        versionSource: parsed.detected ? versionSource || "unknown" : null,
        detectedAt: parsed.detected ? detectedAt || null : null,
        supportsExternalMedia,
        minimumAriMediaVersion: MINIMUM_ARI_EXTERNAL_MEDIA_VERSION,
        configuredAnswerMode: configured,
        recommendedAnswerMode,
        effectiveAnswerMode,
        sipBridgeAvailable: Boolean(sipBridgeAvailable),
        compatibleWithConfiguredMode,
        compatibilityLabel,
        compatibilityWarning,
    };
}

function resolveGatewayCapabilities({
    ariStatus = {},
    pbxStatus = {},
    configuredAnswerMode = "auto",
    sipBridgeAvailable = false,
} = {}) {
    const ariRaw = ariStatus?.asteriskRawVersion || ariStatus?.asteriskVersion || null;
    const pbxRaw = pbxStatus?.asteriskRawVersion || pbxStatus?.asteriskVersion || null;
    const rawVersion = ariRaw || pbxRaw || null;
    const versionSource = ariRaw ? "ari" : pbxRaw ? "ami" : null;
    const detectedAt = ariRaw
        ? ariStatus?.asteriskDetectedAt || null
        : pbxRaw
          ? pbxStatus?.asteriskDetectedAt || null
          : null;

    return buildCapabilitiesSnapshot({
        rawVersion,
        versionSource,
        detectedAt,
        configuredAnswerMode: configuredAnswerMode || pbxStatus?.configuredAnswerMode || "auto",
        sipBridgeAvailable,
    });
}

module.exports = {
    ANSWER_MODES,
    MINIMUM_ARI_EXTERNAL_MEDIA_VERSION,
    normalizeAnswerMode,
    parseAsteriskVersion,
    supportsExternalMediaVersion,
    buildCapabilitiesSnapshot,
    resolveGatewayCapabilities,
};
