const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");

const OUTBOX_FILE_NAME = "outbox.json";
const MAX_DEAD_LETTER = 100;
const RECENT_DEDUPE_WINDOW_MS = 120 * 1000;
const FAST_RETRY_DELAYS_MS = [350, 1200];

function isRetryableHttpStatus(status) {
    if (!status) return true;
    if (status === 408 || status === 429) return true;
    return status >= 500;
}

async function atomicWriteJson(filePath, payload) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8" });
    await fs.rename(tmpPath, filePath);
}

/**
 * Per-call FIFO webhook dispatcher with deduplication, short fast-retries,
 * persistent offline outbox (DATA_DIR/outbox.json), and `historical_sync` tagging
 * for events delayed beyond the live-window threshold during WAN outages.
 */
function extractWebhookAuditContext(outboundBody = {}) {
    const ev = outboundBody && typeof outboundBody.event === "object" && outboundBody.event ? outboundBody.event : {};
    const summary =
        outboundBody && typeof outboundBody.summary === "object" && outboundBody.summary ? outboundBody.summary : {};

    const queue = String(outboundBody.queue || summary.queue || ev.queue || "").trim() || null;
    const caller =
        String(
            outboundBody.caller_id_number ||
                outboundBody.caller ||
                summary.from ||
                ev.caller ||
                ev.callerIdNum ||
                ""
        ).trim() || null;
    const summaryTo = String(summary.to || "").trim();
    const agentExtension =
        String(
            outboundBody.agent_extension ||
                outboundBody.agentExtension ||
                ev.agentExtension ||
                ev.destExtension ||
                (summaryTo && summaryTo !== String(queue || "") ? summaryTo : "") ||
                ""
        ).trim() || null;
    const channel =
        String(
            outboundBody.channel ||
                summary.channel ||
                summary.primaryChannel ||
                ev.channel ||
                ""
        ).trim() || null;
    const dstChannel =
        String(
            outboundBody.dstChannel ||
                outboundBody.dst_channel ||
                summary.dstChannel ||
                ev.destChannel ||
                ""
        ).trim() || null;

    return { queue, caller, agentExtension, channel, dstChannel };
}

class WebhookDispatcherService {
    constructor() {
        this.initialized = false;
        this.stopped = false;
        this.dataDir = null;
        this.outboxPath = null;
        this.maxItems = 5000;
        this.maxConcurrency = 6;
        this.historicalSyncThresholdMs = 5 * 60 * 1000;
        this.getTargetConfig = null;
        this.sender = null;
        this.auditLogger = null;

        this.items = [];
        this.recentDedupe = new Map();
        this.deadLetters = [];
        this.inFlightKeys = new Set();
        this.processing = false;
        this.drainPromise = null;
        this.wakeDrain = null;
        this.retryTimer = null;
        this.persistQueue = Promise.resolve();
        this.persistDirty = false;
        this.consecutiveFailures = 0;

        this.stats = {
            online: true,
            enqueuedCount: 0,
            dedupedCount: 0,
            deliveredCount: 0,
            historicalSyncedCount: 0,
            deadLetterCount: 0,
            droppedOverflowCount: 0,
            lastLatencyMs: null,
            avgLatencyMs: null,
            latencySamples: 0,
            latencyTotalMs: 0,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
        };
    }

    async init(options = {}) {
        this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
        this.outboxPath = path.join(this.dataDir, OUTBOX_FILE_NAME);
        this.maxItems = Number(options.maxItems) > 50 ? Number(options.maxItems) : 5000;
        const parsedConcurrency = Number(options.maxConcurrency);
        this.maxConcurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
            ? Math.min(16, Math.floor(parsedConcurrency))
            : 6;
        this.historicalSyncThresholdMs =
            Number(options.historicalSyncThresholdMs) >= 1000
                ? Number(options.historicalSyncThresholdMs)
                : 5 * 60 * 1000;

        this.getTargetConfig = options.getTargetConfig || (() => ({}));
        this.sender = options.sender || ((url, body, headers, timeoutMs) =>
            axios.post(url, body, { headers, timeout: timeoutMs })
        );
        this.auditLogger = options.auditLogger || null;
        this.stopped = false;

        await fs.mkdir(this.dataDir, { recursive: true });
        await this.loadFromDisk();

        this.initialized = true;

        if (this.items.length > 0) {
            this.scheduleDrain(500);
        }
    }

    stop() {
        this.stopped = true;
        if (this.wakeDrain) {
            this.wakeDrain();
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    async loadFromDisk() {
        try {
            const raw = await fs.readFile(this.outboxPath, "utf8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.items)) {
                this.items = parsed.items;
            }
        } catch (error) {
            if (error && error.code !== "ENOENT") {
                console.warn("[WebhookDispatcher] Could not load outbox.json", error.message);
            }
        }
    }

    async persistToDisk() {
        if (!this.outboxPath) {
            return;
        }

        const snapshot = {
            version: 1,
            savedAt: new Date().toISOString(),
            items: this.items,
        };

        const next = this.persistQueue.then(() => atomicWriteJson(this.outboxPath, snapshot));
        this.persistQueue = next.catch((error) => {
            console.warn("[WebhookDispatcher] Failed saving outbox.json", error.message);
        });
        await next;
    }

    pruneDedupeCache(now = Date.now()) {
        if (this.recentDedupe.size < 300) {
            return;
        }
        for (const [key, ts] of this.recentDedupe.entries()) {
            if (now - ts > RECENT_DEDUPE_WINDOW_MS) {
                this.recentDedupe.delete(key);
            }
        }
    }

    enqueue({ path: targetPath = "/api/trunk-calls/events", payload = {}, linkedid = null, dedupeKey = null }) {
        const now = Date.now();
        this.pruneDedupeCache(now);

        const queueKey = String(linkedid || payload.linkedid || payload.uniqueid || "global");
        const resolvedDedupeKey = dedupeKey ? `${queueKey}:${dedupeKey}` : null;

        if (resolvedDedupeKey) {
            const prevTs = this.recentDedupe.get(resolvedDedupeKey);
            const stillQueued = this.items.some((item) => item.dedupeKey === resolvedDedupeKey);
            if (stillQueued || (prevTs && now - prevTs < RECENT_DEDUPE_WINDOW_MS)) {
                this.stats.dedupedCount += 1;
                return { queued: false, deduped: true, id: null };
            }
            this.recentDedupe.set(resolvedDedupeKey, now);
        }

        if (this.items.length >= this.maxItems) {
            const dropIndex = this.items.findIndex((item) => !item.terminal);
            const indexToRemove = dropIndex >= 0 ? dropIndex : 0;
            this.items.splice(indexToRemove, 1);
            this.stats.droppedOverflowCount += 1;
        }

        const occurredAt = payload.occurred_at || payload.timestamp || new Date(now).toISOString();
        const item = {
            id: crypto.randomUUID(),
            queueKey,
            dedupeKey: resolvedDedupeKey,
            path: targetPath,
            occurredAt,
            createdAtMs: now,
            attempts: 0,
            terminal: Boolean(payload.is_terminal_event),
            payload: {
                ...payload,
                occurred_at: occurredAt,
            },
        };

        this.items.push(item);
        this.stats.enqueuedCount += 1;
        this.persistDirty = true;

        if (!this.stopped) {
            if (this.wakeDrain) {
                this.wakeDrain();
            } else {
                this.scheduleDrain(0);
            }
        }

        return { queued: true, deduped: false, id: item.id };
    }

    scheduleDrain(delayMs = 0) {
        if (this.stopped) {
            return;
        }

        if (this.retryTimer && delayMs > 0) {
            return;
        }

        if (this.retryTimer && delayMs === 0) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.drain().catch(() => {});
        }, Math.max(0, delayMs));

        if (typeof this.retryTimer.unref === "function") {
            this.retryTimer.unref();
        }
    }

    computeOfflineBackoffMs() {
        const exp = Math.min(this.consecutiveFailures, 4);
        return Math.min(30000, 3000 * (2 ** exp));
    }

    pickNextDispatchableIndex() {
        const blockedQueues = new Set();

        for (let i = 0; i < this.items.length; i += 1) {
            const item = this.items[i];
            if (this.inFlightKeys.has(item.queueKey)) {
                blockedQueues.add(item.queueKey);
                continue;
            }
            if (blockedQueues.has(item.queueKey)) {
                continue;
            }
            return i;
        }

        return -1;
    }

    applyItemOutcome(item, outcome) {
        if (outcome.delivered) {
            const removeIdx = this.items.findIndex((entry) => entry.id === item.id);
            if (removeIdx >= 0) {
                this.items.splice(removeIdx, 1);
            }
            this.consecutiveFailures = 0;
            this.stats.online = true;
            this.stats.deliveredCount += 1;
            if (Number.isFinite(outcome.latencyMs)) {
                this.stats.lastLatencyMs = outcome.latencyMs;
                this.stats.latencySamples += 1;
                this.stats.latencyTotalMs += outcome.latencyMs;
                this.stats.avgLatencyMs = Math.round(this.stats.latencyTotalMs / this.stats.latencySamples);
            }
            if (outcome.historicalSync) {
                this.stats.historicalSyncedCount += 1;
            }
            this.stats.lastSuccessAt = new Date().toISOString();
            this.stats.lastError = null;
            this.persistDirty = true;
            return { temporaryFailure: false };
        }

        if (outcome.permanentFailure) {
            const removeIdx = this.items.findIndex((entry) => entry.id === item.id);
            if (removeIdx >= 0) {
                this.items.splice(removeIdx, 1);
            }
            this.pushDeadLetter(item, outcome.error);
            this.persistDirty = true;
            return { temporaryFailure: false };
        }

        return { temporaryFailure: true, error: outcome.error };
    }

    async drain() {
        if (this.stopped) {
            return;
        }
        if (this.processing) {
            return this.drainPromise || undefined;
        }

        this.processing = true;
        this.drainPromise = this.runDrainLoop().finally(() => {
            this.processing = false;
            this.drainPromise = null;
            this.wakeDrain = null;
        });

        return this.drainPromise;
    }

    async runDrainLoop() {
        let offlineHalted = false;
        let lastTemporaryError = null;
        const active = new Map();

        const launchAvailable = () => {
            const limit = this.stats.online ? this.maxConcurrency : 1;
            while (!this.stopped && !offlineHalted && active.size < limit) {
                const idx = this.pickNextDispatchableIndex();
                if (idx < 0) {
                    break;
                }

                const item = this.items[idx];
                this.inFlightKeys.add(item.queueKey);
                const task = this.deliverWithShortRetries(item)
                    .catch((error) => ({
                        delivered: false,
                        permanentFailure: false,
                        error: (error && error.message) || "Webhook delivery failed",
                    }))
                    .then((outcome) => ({ item, outcome, isWorker: true }));
                active.set(item.id, task);
            }
        };

        while (!this.stopped && !offlineHalted) {
            launchAvailable();
            if (active.size === 0) {
                break;
            }

            const limit = this.stats.online ? this.maxConcurrency : 1;
            let wakePromise = null;
            if (active.size < limit) {
                wakePromise = new Promise((resolve) => {
                    this.wakeDrain = () => {
                        this.wakeDrain = null;
                        resolve({ woken: true, isWorker: false });
                    };
                });
            } else {
                this.wakeDrain = null;
            }

            const competitors = wakePromise ? [...active.values(), wakePromise] : [...active.values()];
            const result = await Promise.race(competitors);
            this.wakeDrain = null;

            if (!result || !result.isWorker) {
                continue;
            }

            const { item, outcome } = result;
            active.delete(item.id);
            this.inFlightKeys.delete(item.queueKey);

            const applied = this.applyItemOutcome(item, outcome);
            if (applied.temporaryFailure) {
                offlineHalted = true;
                lastTemporaryError = applied.error;
            }
        }

        this.wakeDrain = null;

        if (active.size > 0) {
            const remaining = await Promise.all(active.values());
            for (const { item, outcome } of remaining) {
                active.delete(item.id);
                this.inFlightKeys.delete(item.queueKey);
                const applied = this.applyItemOutcome(item, outcome);
                if (applied.temporaryFailure) {
                    offlineHalted = true;
                    lastTemporaryError = applied.error;
                }
            }
        }

        if (offlineHalted && !this.stopped) {
            this.consecutiveFailures += 1;
            this.stats.online = false;
            this.stats.lastFailureAt = new Date().toISOString();
            this.stats.lastError = lastTemporaryError;
            this.persistDirty = true;
            await this.persistToDisk();
            this.persistDirty = false;
            this.scheduleDrain(this.computeOfflineBackoffMs());
            return;
        }

        if (this.persistDirty) {
            await this.persistToDisk();
            this.persistDirty = false;
        }
    }

    async deliverWithShortRetries(item) {
        const cfg = this.getTargetConfig();
        if (!cfg || !cfg.enabled || !cfg.baseUrl) {
            return { delivered: false, permanentFailure: true, error: "EVA trunk callback disabled or unconfigured" };
        }

        const url = `${String(cfg.baseUrl).replace(/\/+$/, "")}${item.path}`;
        const headers = {
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        if (cfg.token) {
            headers.Authorization = `Bearer ${cfg.token}`;
        }

        const timeoutMs = Number(cfg.timeoutMs) > 500 ? Number(cfg.timeoutMs) : 15000;

        for (let attempt = 0; attempt <= FAST_RETRY_DELAYS_MS.length; attempt += 1) {
            item.attempts += 1;

            const ageMs = Math.max(0, Date.now() - (Date.parse(item.occurredAt) || item.createdAtMs));
            const historicalSync = ageMs > this.historicalSyncThresholdMs;

            const outboundBody = {
                ...item.payload,
                ...(cfg.tenantDatabase && !item.payload.database ? { database: cfg.tenantDatabase } : {}),
                occurred_at: item.occurredAt,
                historical_sync: historicalSync,
                ...(historicalSync ? { queued_delay_ms: ageMs } : {}),
            };

            try {
                const startedAt = Date.now();
                const response = await this.sender(url, outboundBody, headers, timeoutMs);
                const latencyMs = Math.max(0, Date.now() - startedAt);
                if (this.auditLogger) {
                    const meta = extractWebhookAuditContext(outboundBody);
                    this.auditLogger.record({
                        category: "webhook",
                        type: outboundBody.event_type || outboundBody.event || "trunk_event",
                        linkedid: outboundBody.linkedid || item.queueKey,
                        channel: meta.channel,
                        dstChannel: meta.dstChannel,
                        queue: meta.queue,
                        caller: meta.caller,
                        agentExtension: meta.agentExtension,
                        outcome: historicalSync ? "delivered_historical" : "delivered",
                        summary: `${url} (${response && response.status ? response.status : 200}, ${latencyMs}ms)`,
                    });
                }
                return { delivered: true, historicalSync, latencyMs };
            } catch (error) {
                const status = error && error.response ? error.response.status : null;
                const message =
                    (error && error.response && error.response.data && error.response.data.message) ||
                    (error && error.message) ||
                    "Webhook delivery failed";

                if (!isRetryableHttpStatus(status)) {
                    if (this.auditLogger) {
                        const meta = extractWebhookAuditContext(outboundBody);
                        this.auditLogger.record({
                            category: "webhook",
                            type: "dead_letter",
                            linkedid: outboundBody.linkedid || item.queueKey,
                            channel: meta.channel,
                            dstChannel: meta.dstChannel,
                            queue: meta.queue,
                            caller: meta.caller,
                            agentExtension: meta.agentExtension,
                            outcome: `http_${status}`,
                            summary: message,
                        });
                    }
                    return { delivered: false, permanentFailure: true, error: `${status}: ${message}` };
                }

                if (attempt < FAST_RETRY_DELAYS_MS.length && !this.stopped) {
                    await new Promise((resolve) => setTimeout(resolve, FAST_RETRY_DELAYS_MS[attempt]));
                } else {
                    return {
                        delivered: false,
                        permanentFailure: false,
                        error: status ? `HTTP ${status}: ${message}` : message,
                    };
                }
            }
        }

        return { delivered: false, permanentFailure: false, error: "Exhausted fast retries" };
    }

    pushDeadLetter(item, error) {
        this.stats.deadLetterCount += 1;
        this.deadLetters.push({
            id: item.id,
            queueKey: item.queueKey,
            eventType: item.payload.event_type || item.payload.event || null,
            error,
            failedAt: new Date().toISOString(),
        });
        if (this.deadLetters.length > MAX_DEAD_LETTER) {
            this.deadLetters.splice(0, this.deadLetters.length - MAX_DEAD_LETTER);
        }
    }

    async flush() {
        await this.drain();
        await this.persistQueue;
    }

    getStats() {
        return {
            initialized: this.initialized,
            online: this.stats.online,
            pendingCount: this.items.length,
            activeQueues: this.inFlightKeys.size,
            enqueuedCount: this.stats.enqueuedCount,
            dedupedCount: this.stats.dedupedCount,
            deliveredCount: this.stats.deliveredCount,
            historicalSyncedCount: this.stats.historicalSyncedCount,
            deadLetterCount: this.stats.deadLetterCount,
            droppedOverflowCount: this.stats.droppedOverflowCount,
            lastLatencyMs: this.stats.lastLatencyMs,
            avgLatencyMs: this.stats.avgLatencyMs,
            lastSuccessAt: this.stats.lastSuccessAt,
            lastFailureAt: this.stats.lastFailureAt,
            lastError: this.stats.lastError,
            recentDeadLetters: this.deadLetters.slice(-10),
        };
    }
}

const instance = new WebhookDispatcherService();

module.exports = instance;
module.exports.WebhookDispatcherService = WebhookDispatcherService;

