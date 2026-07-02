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

const path = require("path");

const env = {
    nodeEnv: process.env.NODE_ENV || "development",
    port: toNumber(process.env.PORT, 3002),
    appName: process.env.APP_NAME || "Ariana Asterisk Gateway",
    buildVersion: process.env.APP_BUILD_VERSION || "ari-ai-trunk-v1",
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
    corsOrigins: toList(process.env.CORS_ORIGINS, ["*"]),
    logLevel: process.env.LOG_LEVEL || "info",

    asteriskApiToken:
        process.env.ASTERISK_API_TOKEN ||
        process.env.VOICE_API_TOKEN ||
        "",

    laravelApiUrl: process.env.LARAVEL_API_URL || "http://localhost",
    laravelApiToken: process.env.LARAVEL_API_TOKEN || "",
    laravelVoiceToolsToken:
        process.env.LARAVEL_VOICE_TOOLS_TOKEN ||
        process.env.LARAVEL_API_TOKEN ||
        "",
    laravelTenantDatabase:
        process.env.LARAVEL_TENANT_DATABASE ||
        process.env.LARAVEL_DATABASE ||
        process.env.TENANT_DATABASE ||
        "sigcrm_intelho",
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

    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiSttModel: process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe",
    openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
    openaiRealtimeVoice: process.env.OPENAI_REALTIME_VOICE || "marin",
    openaiRealtimeTranscriptionModel:
        process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
    trunkAiEnabled: toBoolean(process.env.TRUNK_AI_ENABLED, true),
    trunkAiLanguage: process.env.TRUNK_AI_LANGUAGE || "es",
    trunkAiRealtimeConnectTimeoutMs: toNumber(process.env.TRUNK_AI_REALTIME_CONNECT_TIMEOUT_MS, 10000),
    trunkAiRealtimeToolTimeoutMs: toNumber(process.env.TRUNK_AI_REALTIME_TOOL_TIMEOUT_MS, 12000),
    trunkAiInputSampleRate: toNumber(process.env.TRUNK_AI_INPUT_SAMPLE_RATE, 24000),
    trunkAiOutputSampleRate: toNumber(process.env.TRUNK_AI_OUTPUT_SAMPLE_RATE, 24000),
    trunkAiVadThreshold: toNumber(process.env.TRUNK_AI_VAD_THRESHOLD, 0.65),
    trunkAiTurnSilenceMs: toNumber(process.env.TRUNK_AI_TURN_SILENCE_MS, 500),
    trunkAiInterruptionDebounceMs: toNumber(process.env.TRUNK_AI_INTERRUPTION_DEBOUNCE_MS, 300),
    trunkAiInterruptionRmsThreshold: toNumber(process.env.TRUNK_AI_INTERRUPTION_RMS_THRESHOLD, 0.02),
    trunkAiInterruptionMinSpeechMs: toNumber(process.env.TRUNK_AI_INTERRUPTION_MIN_SPEECH_MS, 250),
    trunkAiInterruptionWindowMs: toNumber(process.env.TRUNK_AI_INTERRUPTION_WINDOW_MS, 700),
    callAudioLanguage: process.env.CALL_AUDIO_LANGUAGE || "es",
    callRecordingEnabled: toBoolean(process.env.CALL_RECORDING_ENABLED, true),
    callRecordingTranscribe: toBoolean(process.env.CALL_RECORDING_TRANSCRIBE, true),
    callCallbackTimeoutMs: toNumber(process.env.CALL_CALLBACK_TIMEOUT_MS, 30000),
    maxAudioUploadMb: toNumber(process.env.MAX_AUDIO_UPLOAD_MB, 25),
    tmpDir: process.env.TMP_DIR || path.join(process.cwd(), "tmp"),
    audioUploadDir:
        process.env.AUDIO_UPLOAD_DIR || path.join(process.cwd(), "tmp", "uploads"),
    recordingOutputDir:
        process.env.RECORDING_OUTPUT_DIR || path.join(process.cwd(), "tmp", "recordings"),

    pbxAmiEnabled: toBoolean(process.env.PBX_AMI_ENABLED, false),
    pbxAmiHost: process.env.PBX_AMI_HOST || "127.0.0.1",
    pbxAmiPort: toNumber(process.env.PBX_AMI_PORT, 5038),
    pbxAmiUsername: process.env.PBX_AMI_USERNAME || "",
    pbxAmiPassword: process.env.PBX_AMI_PASSWORD || "",
    pbxAmiReconnect: toBoolean(process.env.PBX_AMI_RECONNECT, true),
    pbxAmiEventMask: process.env.PBX_AMI_EVENT_MASK || "on",
    pbxLogTrackedEvents: toBoolean(process.env.PBX_LOG_TRACKED_EVENTS, true),
    pbxLogRawEvents: toBoolean(process.env.PBX_LOG_RAW_EVENTS, false),
    pbxLogVerboseRawEvents: toBoolean(process.env.PBX_LOG_VERBOSE_RAW_EVENTS, false),
    pbxLogLaravelCallbacks: toBoolean(process.env.PBX_LOG_LARAVEL_CALLBACKS, true),
    pbxMaxEvents: toNumber(process.env.PBX_MAX_EVENTS, 300),
    pbxOriginateContext: process.env.PBX_ORIGINATE_CONTEXT || "from-internal",
    pbxOriginatePriority: toNumber(process.env.PBX_ORIGINATE_PRIORITY, 1),
    pbxOriginateTimeoutMs: toNumber(process.env.PBX_ORIGINATE_TIMEOUT_MS, 30000),
    pbxCallerIdPrefix: process.env.PBX_CALLER_ID_PREFIX || "Ariana",
    pbxDirectTrunkEndpoint: process.env.PBX_DIRECT_TRUNK_ENDPOINT || "fxo",
    pbxHangupCause: toNumber(process.env.PBX_HANGUP_CAUSE, 16),

    ariEnabled: toBoolean(
        process.env.ARI_ENABLED ||
            process.env.ASTERISK_ARI_ENABLED,
        false
    ),
    ariBaseUrl:
        process.env.ARI_BASE_URL ||
        process.env.ASTERISK_ARI_BASE_URL ||
        "http://127.0.0.1:8088",
    ariWsUrl:
        process.env.ARI_WS_URL ||
        process.env.ASTERISK_ARI_WS_URL ||
        "",
    ariUsername:
        process.env.ARI_USERNAME ||
        process.env.ASTERISK_ARI_USERNAME ||
        "",
    ariPassword:
        process.env.ARI_PASSWORD ||
        process.env.ASTERISK_ARI_PASSWORD ||
        "",
    ariAppName:
        process.env.ARI_APP_NAME ||
        process.env.ASTERISK_ARI_APP_NAME ||
        "ariana-trunk",
    ariReconnectMs: toNumber(process.env.ARI_RECONNECT_MS, 3000),
    ariRequestTimeoutMs: toNumber(process.env.ARI_REQUEST_TIMEOUT_MS, 15000),
    ariMaxEvents: toNumber(process.env.ARI_MAX_EVENTS, 300),
    ariLaravelEventsEnabled: toBoolean(
        process.env.ARI_LARAVEL_EVENTS_ENABLED,
        false
    ),
    ariAutoAnswer: toBoolean(process.env.ARI_AUTO_ANSWER, false),
    ariAutoBridge: toBoolean(process.env.ARI_AUTO_BRIDGE, false),
    ariAutoPlaybackMedia: process.env.ARI_AUTO_PLAYBACK_MEDIA || "",
    ariStasisRedirectEnabled: toBoolean(process.env.ARI_STASIS_REDIRECT_ENABLED, true),
    ariStasisContext: process.env.ARI_STASIS_CONTEXT || "ariana-ari",
    ariStasisExtension: process.env.ARI_STASIS_EXTENSION || "s",
    ariStasisPriority: toNumber(process.env.ARI_STASIS_PRIORITY, 1),
    ariStasisWaitMs: toNumber(process.env.ARI_STASIS_WAIT_MS, 5000),
    ariBridgeWaitMs: toNumber(process.env.ARI_BRIDGE_WAIT_MS, 10000),
    ariExternalMediaHost: process.env.ARI_EXTERNAL_MEDIA_HOST || "127.0.0.1",
    ariExternalMediaBindHost: process.env.ARI_EXTERNAL_MEDIA_BIND_HOST || "0.0.0.0",
    ariExternalMediaPortStart: toNumber(process.env.ARI_EXTERNAL_MEDIA_PORT_START, 46000),
    ariExternalMediaPortEnd: toNumber(process.env.ARI_EXTERNAL_MEDIA_PORT_END, 46100),
    ariExternalMediaFormat: process.env.ARI_EXTERNAL_MEDIA_FORMAT || "ulaw",
    ariExternalMediaPayloadType: toNumber(process.env.ARI_EXTERNAL_MEDIA_PAYLOAD_TYPE, 0),
    ariExternalMediaFrameMs: toNumber(process.env.ARI_EXTERNAL_MEDIA_FRAME_MS, 20),
};

module.exports = env;
