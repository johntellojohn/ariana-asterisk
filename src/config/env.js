require("dotenv").config();

function toNumber(value, fallback) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
}

function toList(value, fallback = []) {
    if (!value) {
        return fallback;
    }

    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }

    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const laravelTrunkEventsPath =
    process.env.LARAVEL_TRUNK_EVENTS_PATH ||
    process.env.PBX_LARAVEL_EVENTS_PATH ||
    "/api/trunk-calls/events";

const env = {
    nodeEnv: process.env.NODE_ENV || "development",
    port: toNumber(process.env.PORT, 3002),
    appName: process.env.APP_NAME || "Ariana Asterisk Gateway",
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
    corsOrigins: toList(process.env.CORS_ORIGINS, ["*"]),
    logLevel: process.env.LOG_LEVEL || "info",

    asteriskApiToken:
        process.env.ASTERISK_API_TOKEN ||
        process.env.VOICE_API_TOKEN ||
        "",

    laravelApiUrl: process.env.LARAVEL_API_URL || "http://localhost",
    laravelApiToken: process.env.LARAVEL_API_TOKEN || "",
    laravelTenantDatabase:
        process.env.LARAVEL_TENANT_DATABASE ||
        process.env.LARAVEL_DATABASE ||
        process.env.TENANT_DATABASE ||
        "",
    laravelTrunkEventsEnabled: toBoolean(
        process.env.LARAVEL_TRUNK_EVENTS_ENABLED ||
            process.env.PBX_LARAVEL_EVENTS_ENABLED,
        false
    ),
    laravelTrunkEventsPath,
    laravelCallbackTimeoutMs: toNumber(
        process.env.LARAVEL_CALLBACK_TIMEOUT_MS,
        30000
    ),

    pbxAmiEnabled: toBoolean(process.env.PBX_AMI_ENABLED, false),
    pbxAmiHost: process.env.PBX_AMI_HOST || "127.0.0.1",
    pbxAmiPort: toNumber(process.env.PBX_AMI_PORT, 5038),
    pbxAmiUsername: process.env.PBX_AMI_USERNAME || "",
    pbxAmiPassword: process.env.PBX_AMI_PASSWORD || "",
    pbxAmiReconnect: toBoolean(process.env.PBX_AMI_RECONNECT, true),
    pbxAmiEventMask: process.env.PBX_AMI_EVENT_MASK || "on",
    pbxLogTrackedEvents: toBoolean(process.env.PBX_LOG_TRACKED_EVENTS, true),
    pbxLogRawEvents: toBoolean(process.env.PBX_LOG_RAW_EVENTS, false),
    pbxLogLaravelCallbacks: toBoolean(process.env.PBX_LOG_LARAVEL_CALLBACKS, true),
    pbxMaxEvents: toNumber(process.env.PBX_MAX_EVENTS, 300),
    pbxOriginateContext: process.env.PBX_ORIGINATE_CONTEXT || "from-internal",
    pbxOriginatePriority: toNumber(process.env.PBX_ORIGINATE_PRIORITY, 1),
    pbxOriginateTimeoutMs: toNumber(process.env.PBX_ORIGINATE_TIMEOUT_MS, 30000),
    pbxCallerIdPrefix: process.env.PBX_CALLER_ID_PREFIX || "Ariana",
    pbxDirectTrunkEndpoint: process.env.PBX_DIRECT_TRUNK_ENDPOINT || "fxo",
    pbxHangupCause: toNumber(process.env.PBX_HANGUP_CAUSE, 16),
};

module.exports = env;
