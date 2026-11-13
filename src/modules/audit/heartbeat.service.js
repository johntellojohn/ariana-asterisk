const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");

const HEARTBEAT_FILE_NAME = "heartbeats.json";
const MAX_LOCAL_HEARTBEATS = 60;

async function atomicWriteJson(filePath, payload) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8" });
    await fs.rename(tmpPath, filePath);
}

/**
 * Sends a periodic 60s health telemetry heartbeat from Edge Gateway to EVA Cloud,
 * tolerating temporary offline intervals and missing endpoints gracefully.
 */
class HeartbeatService {
    constructor() {
        this.initialized = false;
        this.dataDir = null;
        this.filePath = null;
        this.timer = null;
        this.collectPayload = null;
        this.getTargetConfig = null;
        this.sender = null;
        this.recent = [];
        this.status = {
            enabled: false,
            evaReachable: null,
            endpointSupported: null,
            lastSentAt: null,
            lastLatencyMs: null,
            lastHttpStatus: null,
            lastError: null,
        };
    }

    async init(options = {}) {
        this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
        this.filePath = path.join(this.dataDir, HEARTBEAT_FILE_NAME);
        this.collectPayload = options.collectPayload || (() => ({}));
        this.getTargetConfig = options.getTargetConfig || (() => ({}));
        this.sender = options.sender || ((url, body, headers, timeoutMs) =>
            axios.post(url, body, { headers, timeout: timeoutMs })
        );

        await fs.mkdir(this.dataDir, { recursive: true });
        try {
            const raw = await fs.readFile(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.recent)) {
                this.recent = parsed.recent.slice(-MAX_LOCAL_HEARTBEATS);
            }
        } catch (_error) {
            this.recent = [];
        }

        this.initialized = true;
    }

    start(intervalMs = 60000) {
        this.stop();
        const safeInterval = Math.max(10000, Number(intervalMs) || 60000);
        this.status.enabled = true;

        this.sendOnce().catch(() => {});
        this.timer = setInterval(() => {
            this.sendOnce().catch(() => {});
        }, safeInterval);

        if (typeof this.timer.unref === "function") {
            this.timer.unref();
        }
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async sendOnce() {
        const cfg = this.getTargetConfig();
        const snapshot = {
            sent_at: new Date().toISOString(),
            ...this.collectPayload(),
        };

        if (!cfg || !cfg.enabled || !cfg.baseUrl || cfg.baseUrl === "http://localhost") {
            this.status.enabled = Boolean(cfg && cfg.enabled);
            return { skipped: true, reason: "Heartbeat disabled or EVA URL not configured" };
        }

        this.status.enabled = true;
        const url = `${String(cfg.baseUrl).replace(/\/+$/, "")}${cfg.path || "/api/trunk-calls/heartbeat"}`;
        const headers = {
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        if (cfg.token) {
            headers.Authorization = `Bearer ${cfg.token}`;
        }

        const body = {
            ...snapshot,
            ...(cfg.tenantDatabase ? { database: cfg.tenantDatabase } : {}),
        };

        const startedAt = Date.now();
        try {
            const response = await this.sender(url, body, headers, cfg.timeoutMs || 10000);
            const latencyMs = Date.now() - startedAt;

            this.status.evaReachable = true;
            this.status.endpointSupported = true;
            this.status.lastSentAt = snapshot.sent_at;
            this.status.lastLatencyMs = latencyMs;
            this.status.lastHttpStatus = response && response.status ? response.status : 200;
            this.status.lastError = null;

            this.recordLocal({ ts: snapshot.sent_at, ok: true, latencyMs, httpStatus: this.status.lastHttpStatus });
            return { ok: true, latencyMs, status: this.status.lastHttpStatus };
        } catch (error) {
            const latencyMs = Date.now() - startedAt;
            const httpStatus = error && error.response ? error.response.status : null;
            const message = error && error.message ? error.message : "Heartbeat failed";

            this.status.lastSentAt = snapshot.sent_at;
            this.status.lastLatencyMs = latencyMs;
            this.status.lastHttpStatus = httpStatus;

            if (httpStatus === 404 || httpStatus === 405) {
                this.status.evaReachable = true;
                this.status.endpointSupported = false;
                this.status.lastError = `EVA responded ${httpStatus} (heartbeat endpoint pending Fase 3)`;
            } else {
                this.status.evaReachable = false;
                this.status.lastError = message;
            }

            this.recordLocal({
                ts: snapshot.sent_at,
                ok: false,
                offline: !httpStatus,
                latencyMs,
                httpStatus,
                error: this.status.lastError,
            });
            return { ok: false, httpStatus, error: this.status.lastError };
        }
    }

    recordLocal(entry) {
        this.recent.push(entry);
        if (this.recent.length > MAX_LOCAL_HEARTBEATS) {
            this.recent.splice(0, this.recent.length - MAX_LOCAL_HEARTBEATS);
        }
        if (this.filePath) {
            atomicWriteJson(this.filePath, { recent: this.recent }).catch(() => {});
        }
    }

    getStatus() {
        return {
            ...this.status,
            recentCount: this.recent.length,
            recent: this.recent.slice(-10),
        };
    }
}

const instance = new HeartbeatService();

module.exports = instance;
module.exports.HeartbeatService = HeartbeatService;

