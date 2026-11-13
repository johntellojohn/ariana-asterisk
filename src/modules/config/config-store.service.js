const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { normalizePublicBaseUrl } = require("../../utils/public-url");

const CONFIG_FILE_NAME = "config.enc.json";
const MASTER_KEY_FILE_NAME = ".master.key";

const CONFIG_FIELDS = [
    // Gateway
    { key: "appName", type: "string", secret: false },
    { key: "publicBaseUrl", type: "string", secret: false },
    { key: "corsOrigins", type: "list", secret: false },
    { key: "asteriskApiToken", type: "string", secret: true },
    { key: "logLevel", type: "string", secret: false },

    // EVA / Laravel Cloud
    { key: "laravelApiUrl", type: "string", secret: false },
    { key: "laravelApiToken", type: "string", secret: true },
    { key: "laravelVoiceToolsToken", type: "string", secret: true },
    { key: "laravelTenantDatabase", type: "string", secret: false },
    { key: "laravelTrunkEventsEnabled", type: "boolean", secret: false },
    { key: "laravelTrunkEventsPath", type: "string", secret: false },
    { key: "laravelCallbackTimeoutMs", type: "number", secret: false, min: 1000, max: 120000 },
    { key: "laravelHeartbeatEnabled", type: "boolean", secret: false },
    { key: "laravelHeartbeatPath", type: "string", secret: false },
    { key: "laravelHeartbeatIntervalMs", type: "number", secret: false, min: 10000, max: 600000 },

    // Asterisk AMI & Queue
    { key: "pbxAmiEnabled", type: "boolean", secret: false },
    { key: "pbxAmiHost", type: "string", secret: false },
    { key: "pbxAmiPort", type: "number", secret: false, min: 1, max: 65535 },
    { key: "pbxAmiUsername", type: "string", secret: false },
    { key: "pbxAmiPassword", type: "string", secret: true },
    { key: "pbxAmiReconnect", type: "boolean", secret: false },
    { key: "pbxAmiEventMask", type: "string", secret: false },
    { key: "pbxOriginateContext", type: "string", secret: false },
    { key: "pbxOriginatePriority", type: "number", secret: false, min: 1, max: 99 },
    { key: "pbxOriginateTimeoutMs", type: "number", secret: false, min: 5000, max: 300000 },
    { key: "pbxCallerIdPrefix", type: "string", secret: false },
    { key: "pbxDefaultCallerIdNumber", type: "string", secret: false },
    { key: "pbxDirectTrunkEndpoint", type: "string", secret: false },
    { key: "pbxHangupCause", type: "number", secret: false, min: 0, max: 255 },
    { key: "trunkOutboundEnabled", type: "boolean", secret: false },
    { key: "pbxLogTrackedEvents", type: "boolean", secret: false },
    { key: "pbxLogRawEvents", type: "boolean", secret: false },
    { key: "pbxLogVerboseRawEvents", type: "boolean", secret: false },
    { key: "pbxLogLaravelCallbacks", type: "boolean", secret: false },

    // Asterisk ARI & ExternalMedia RTP
    { key: "ariEnabled", type: "boolean", secret: false },
    { key: "ariBaseUrl", type: "string", secret: false },
    { key: "ariWsUrl", type: "string", secret: false },
    { key: "ariUsername", type: "string", secret: false },
    { key: "ariPassword", type: "string", secret: true },
    { key: "ariAppName", type: "string", secret: false },
    { key: "ariReconnectMs", type: "number", secret: false, min: 500, max: 60000 },
    { key: "ariRequestTimeoutMs", type: "number", secret: false, min: 1000, max: 120000 },
    { key: "ariLaravelEventsEnabled", type: "boolean", secret: false },
    { key: "ariStasisRedirectEnabled", type: "boolean", secret: false },
    { key: "ariStasisContext", type: "string", secret: false },
    { key: "ariStasisExtension", type: "string", secret: false },
    { key: "ariStasisPriority", type: "number", secret: false, min: 1, max: 99 },
    { key: "ariStasisWaitMs", type: "number", secret: false, min: 500, max: 30000 },
    { key: "ariBridgeWaitMs", type: "number", secret: false, min: 1000, max: 30000 },
    { key: "ariExternalMediaHost", type: "string", secret: false },
    { key: "ariExternalMediaBindHost", type: "string", secret: false },
    { key: "ariExternalMediaPortStart", type: "number", secret: false, min: 1024, max: 65534 },
    { key: "ariExternalMediaPortEnd", type: "number", secret: false, min: 1025, max: 65535 },

    // AI / Audio
    { key: "trunkAiEnabled", type: "boolean", secret: false },
    { key: "openaiApiKey", type: "string", secret: true },
    { key: "openaiRealtimeModel", type: "string", secret: false },
    { key: "openaiRealtimeVoice", type: "string", secret: false },
    { key: "callRecordingEnabled", type: "boolean", secret: false },
    { key: "callRecordingTranscribe", type: "boolean", secret: false },
    { key: "callRecordingAnalyze", type: "boolean", secret: false },
];

const FIELD_MAP = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));

function isSecretMasked(value) {
    return typeof value === "string" && value.startsWith("****");
}

function maskSecret(value) {
    if (!value) {
        return "";
    }

    const str = String(value);

    if (str.length <= 4) {
        return "****";
    }

    return `****${str.slice(-4)}`;
}

function coerceValue(field, rawValue) {
    if (field.type === "boolean") {
        if (typeof rawValue === "boolean") {
            return rawValue;
        }

        if (rawValue === undefined || rawValue === null || rawValue === "") {
            return false;
        }

        return ["1", "true", "yes", "on"].includes(String(rawValue).trim().toLowerCase());
    }

    if (field.type === "number") {
        const parsed = Number(rawValue);

        if (!Number.isFinite(parsed)) {
            throw new Error(`Invalid numeric value for ${field.key}`);
        }

        const rounded = Math.trunc(parsed);

        if (field.min !== undefined && rounded < field.min) {
            throw new Error(`${field.key} must be >= ${field.min}`);
        }

        if (field.max !== undefined && rounded > field.max) {
            throw new Error(`${field.key} must be <= ${field.max}`);
        }

        return rounded;
    }

    if (field.type === "list") {
        if (Array.isArray(rawValue)) {
            return rawValue.map((item) => String(item).trim()).filter(Boolean);
        }

        if (typeof rawValue === "string") {
            return rawValue
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean);
        }

        return ["*"];
    }

    return rawValue === undefined || rawValue === null ? "" : String(rawValue).trim();
}

async function atomicWriteJson(filePath, payload) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
}

/**
 * Persists encrypted runtime configuration under DATA_DIR and hot-applies it to `env`.
 */
class ConfigStoreService {
    constructor() {
        this.initialized = false;
        this.dataDir = null;
        this.targetEnv = null;
        this.masterKey = null;
        this.config = {};
        this.meta = {
            source: "env",
            updatedAt: null,
            configured: false,
            pendingReasons: [],
        };
        this.writeQueue = Promise.resolve();
    }

    async init(targetEnv, options = {}) {
        this.targetEnv = targetEnv;
        this.dataDir = path.resolve(options.dataDir || targetEnv.dataDir || path.join(process.cwd(), "data"));
        await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });

        this.masterKey = await this.resolveMasterKey(options.masterKey || targetEnv.configMasterKey);

        const configPath = this.getConfigFilePath();
        const envSnapshot = this.extractSnapshot(targetEnv);

        let loadedFromDisk = false;

        try {
            const raw = await fs.readFile(configPath, "utf8");
            const encrypted = JSON.parse(raw);
            const decrypted = this.decryptPayload(encrypted);
            this.config = { ...envSnapshot, ...this.sanitizeSnapshot(decrypted.values || {}) };
            this.meta.source = "disk";
            this.meta.updatedAt = decrypted.updatedAt || null;
            loadedFromDisk = true;
        } catch (error) {
            if (error && error.code !== "ENOENT") {
                console.warn("[ConfigStore] Failed to load persisted config.enc.json; falling back to env bootstrap", {
                    message: error.message,
                });
            }
            this.config = envSnapshot;
            this.meta.source = this.hasBootstrapEnvValues(envSnapshot) ? "env-bootstrap" : "pending-setup";
            this.meta.updatedAt = null;
        }

        if (!loadedFromDisk && this.hasBootstrapEnvValues(this.config)) {
            await this.persistEncryptedConfig();
        }

        this.applyToEnv(targetEnv);
        this.refreshReadinessMeta();
        this.initialized = true;

        return this.getStatus();
    }

    getConfigFilePath() {
        return path.join(this.dataDir, CONFIG_FILE_NAME);
    }

    async resolveMasterKey(configuredSecret) {
        if (configuredSecret && String(configuredSecret).trim()) {
            return crypto.createHash("sha256").update(String(configuredSecret).trim()).digest();
        }

        const keyFilePath = path.join(this.dataDir, MASTER_KEY_FILE_NAME);

        try {
            const hex = (await fs.readFile(keyFilePath, "utf8")).trim();
            if (/^[0-9a-f]{64}$/i.test(hex)) {
                return Buffer.from(hex, "hex");
            }
        } catch (error) {
            if (error && error.code !== "ENOENT") {
                throw error;
            }
        }

        const generated = crypto.randomBytes(32);
        const tmpPath = `${keyFilePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmpPath, generated.toString("hex"), { encoding: "utf8", mode: 0o600 });
        await fs.rename(tmpPath, keyFilePath);
        return generated;
    }

    encryptPayload(payload) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv);
        const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();

        return {
            version: 1,
            alg: "aes-256-gcm",
            iv: iv.toString("base64"),
            tag: tag.toString("base64"),
            ciphertext: ciphertext.toString("base64"),
        };
    }

    decryptPayload(envelope) {
        if (!envelope || envelope.alg !== "aes-256-gcm") {
            throw new Error("Unsupported encrypted config envelope");
        }

        const iv = Buffer.from(envelope.iv, "base64");
        const tag = Buffer.from(envelope.tag, "base64");
        const ciphertext = Buffer.from(envelope.ciphertext, "base64");
        const decipher = crypto.createDecipheriv("aes-256-gcm", this.masterKey, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(plaintext.toString("utf8"));
    }

    extractSnapshot(sourceEnv) {
        const snapshot = {};

        for (const field of CONFIG_FIELDS) {
            if (sourceEnv[field.key] !== undefined) {
                snapshot[field.key] = coerceValue(field, sourceEnv[field.key]);
            }
        }

        return snapshot;
    }

    sanitizeSnapshot(rawValues) {
        const clean = {};

        for (const [key, rawValue] of Object.entries(rawValues || {})) {
            const field = FIELD_MAP.get(key);
            if (!field) {
                continue;
            }
            clean[key] = coerceValue(field, rawValue);
        }

        return clean;
    }

    hasBootstrapEnvValues(snapshot) {
        const hasAmi = Boolean(snapshot.pbxAmiHost && snapshot.pbxAmiHost !== "127.0.0.1" && snapshot.pbxAmiUsername);
        const hasEva = Boolean(snapshot.laravelApiToken && snapshot.laravelTenantDatabase);
        const hasAri = Boolean(snapshot.ariUsername && snapshot.ariBaseUrl && snapshot.ariBaseUrl !== "http://127.0.0.1:8088");
        return hasAmi || hasEva || hasAri;
    }

    computePendingReasons(cfg = this.config) {
        const reasons = [];

        if (cfg.pbxAmiEnabled) {
            if (!cfg.pbxAmiHost) reasons.push("pbxAmiHost");
            if (!cfg.pbxAmiUsername) reasons.push("pbxAmiUsername");
            if (!cfg.pbxAmiPassword) reasons.push("pbxAmiPassword");
        }

        if (cfg.ariEnabled) {
            if (!cfg.ariBaseUrl) reasons.push("ariBaseUrl");
            if (!cfg.ariUsername) reasons.push("ariUsername");
            if (!cfg.ariPassword) reasons.push("ariPassword");
        }

        if (cfg.laravelTrunkEventsEnabled || cfg.laravelHeartbeatEnabled) {
            if (!cfg.laravelApiUrl || cfg.laravelApiUrl === "http://localhost") {
                reasons.push("laravelApiUrl");
            }
            if (!cfg.laravelApiToken) reasons.push("laravelApiToken");
            if (!cfg.laravelTenantDatabase) reasons.push("laravelTenantDatabase");
        }

        const hasAnyActiveSubsystem = Boolean(cfg.pbxAmiEnabled || cfg.ariEnabled);
        if (!hasAnyActiveSubsystem) {
            reasons.push("noActivePbxSubsystem");
        }

        return reasons;
    }

    refreshReadinessMeta() {
        const reasons = this.computePendingReasons(this.config);
        this.meta.pendingReasons = reasons;
        this.meta.configured = reasons.length === 0;
    }

    isConfigured() {
        return this.meta.configured;
    }

    isAmiReady() {
        return Boolean(
            this.config.pbxAmiEnabled &&
            this.config.pbxAmiHost &&
            this.config.pbxAmiUsername &&
            this.config.pbxAmiPassword
        );
    }

    isAriReady() {
        return Boolean(
            this.config.ariEnabled &&
            this.config.ariBaseUrl &&
            this.config.ariUsername &&
            this.config.ariPassword
        );
    }

    applyToEnv(targetEnv = this.targetEnv) {
        if (!targetEnv) {
            return;
        }

        for (const field of CONFIG_FIELDS) {
            if (this.config[field.key] !== undefined) {
                targetEnv[field.key] = this.config[field.key];
            }
        }

        if (this.config.publicBaseUrl) {
            targetEnv.publicBaseUrl = normalizePublicBaseUrl(
                this.config.publicBaseUrl,
                targetEnv.nodeEnv || "development"
            );
        }

        if (targetEnv.laravelApiUrl) {
            targetEnv.laravelApiUrl = String(targetEnv.laravelApiUrl).trim().replace(/\/+$/, "");
        }
    }

    async persistEncryptedConfig() {
        const updatedAt = new Date().toISOString();
        const envelope = this.encryptPayload({
            updatedAt,
            values: this.config,
        });
        this.meta.updatedAt = updatedAt;

        const nextWrite = this.writeQueue.then(() => atomicWriteJson(this.getConfigFilePath(), envelope));
        this.writeQueue = nextWrite.catch(() => {});
        await nextWrite;
    }

    async updateConfig(patch = {}) {
        if (!this.initialized) {
            throw new Error("ConfigStoreService is not initialized");
        }

        const nextConfig = { ...this.config };
        const changedKeys = [];

        for (const [key, rawValue] of Object.entries(patch || {})) {
            const field = FIELD_MAP.get(key);
            if (!field) {
                continue;
            }

            if (field.secret) {
                if (rawValue === undefined || rawValue === null || rawValue === "" || isSecretMasked(rawValue)) {
                    if (patch[`__clear_${key}`] === true) {
                        nextConfig[key] = "";
                        changedKeys.push(key);
                    }
                    continue;
                }
            }

            const coerced = coerceValue(field, rawValue);
            const prevJson = JSON.stringify(nextConfig[key]);
            const nextJson = JSON.stringify(coerced);

            if (prevJson !== nextJson) {
                nextConfig[key] = coerced;
                changedKeys.push(key);
            }
        }

        if (
            nextConfig.ariExternalMediaPortEnd !== undefined &&
            nextConfig.ariExternalMediaPortStart !== undefined &&
            nextConfig.ariExternalMediaPortEnd <= nextConfig.ariExternalMediaPortStart
        ) {
            throw new Error("ariExternalMediaPortEnd must be greater than ariExternalMediaPortStart");
        }

        this.config = nextConfig;
        this.meta.source = "disk";
        this.refreshReadinessMeta();
        this.applyToEnv(this.targetEnv);
        await this.persistEncryptedConfig();

        const amiChanged = changedKeys.some((key) => key.startsWith("pbxAmi"));
        const ariChanged = changedKeys.some((key) => key.startsWith("ari"));
        const evaChanged = changedKeys.some((key) => key.startsWith("laravel"));

        return {
            changedKeys,
            amiChanged,
            ariChanged,
            evaChanged,
            status: this.getStatus(),
            config: this.getPublicConfig(),
        };
    }

    getPublicConfig() {
        const values = {};
        const secretsSet = {};

        for (const field of CONFIG_FIELDS) {
            const current = this.config[field.key];
            if (field.secret) {
                secretsSet[field.key] = Boolean(current);
                values[field.key] = maskSecret(current);
            } else {
                values[field.key] = current;
            }
        }

        return {
            values,
            secretsSet,
            meta: this.getStatus(),
        };
    }

    getStatus() {
        return {
            initialized: this.initialized,
            dataDir: this.dataDir,
            source: this.meta.source,
            updatedAt: this.meta.updatedAt,
            configured: this.meta.configured,
            amiReady: this.isAmiReady(),
            ariReady: this.isAriReady(),
            pendingReasons: [...this.meta.pendingReasons],
        };
    }
}

const instance = new ConfigStoreService();

module.exports = instance;
module.exports.ConfigStoreService = ConfigStoreService;
module.exports.CONFIG_FIELDS = CONFIG_FIELDS;

