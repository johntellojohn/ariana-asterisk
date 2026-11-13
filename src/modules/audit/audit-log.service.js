const fs = require("fs/promises");
const path = require("path");

const AUDIT_DIR_NAME = "audit";
const MAX_RECENT_IN_MEMORY = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatDayStamp(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

/**
 * Daily-rotated JSONL "blackbox" audit log under DATA_DIR/audit/
 * with a non-blocking write queue and bounded in-memory ring buffer.
 */
class AuditLogService {
    constructor() {
        this.initialized = false;
        this.auditDir = null;
        this.retentionDays = 15;
        this.recentEntries = [];
        this.writeQueue = Promise.resolve();
        this.pruneTimer = null;
    }

    async init(options = {}) {
        const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
        this.auditDir = path.join(dataDir, AUDIT_DIR_NAME);
        this.retentionDays = Number(options.retentionDays) >= 1 ? Number(options.retentionDays) : 15;

        await fs.mkdir(this.auditDir, { recursive: true });
        await this.pruneExpiredFiles();
        await this.loadLatestFromDisk();

        this.initialized = true;

        if (!this.pruneTimer) {
            this.pruneTimer = setInterval(() => {
                this.pruneExpiredFiles().catch(() => {});
            }, 6 * 60 * 60 * 1000);
            if (typeof this.pruneTimer.unref === "function") {
                this.pruneTimer.unref();
            }
        }
    }

    stop() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
    }

    async loadLatestFromDisk() {
        try {
            const todayFile = path.join(this.auditDir, `events-${formatDayStamp()}.jsonl`);
            const raw = await fs.readFile(todayFile, "utf8");
            const lines = raw.trim().split(/\r?\n/).filter(Boolean);
            const tail = lines.slice(-MAX_RECENT_IN_MEMORY);
            this.recentEntries = tail
                .map((line) => {
                    try {
                        return JSON.parse(line);
                    } catch (_err) {
                        return null;
                    }
                })
                .filter(Boolean);
        } catch (error) {
            if (error && error.code !== "ENOENT") {
                console.warn("[AuditLog] Failed to preload today audit log", error.message);
            }
        }
    }

    record(entry = {}) {
        const record = {
            ts: entry.ts || new Date().toISOString(),
            category: entry.category || "system",
            type: entry.type || "event",
            linkedid: entry.linkedid || null,
            queue: entry.queue || null,
            caller: entry.caller || null,
            agentExtension: entry.agentExtension || null,
            outcome: entry.outcome || "ok",
            summary: entry.summary || null,
            meta: entry.meta || null,
        };

        this.recentEntries.push(record);
        if (this.recentEntries.length > MAX_RECENT_IN_MEMORY) {
            this.recentEntries.splice(0, this.recentEntries.length - MAX_RECENT_IN_MEMORY);
        }

        if (this.initialized && this.auditDir) {
            const dayStamp = String(record.ts).slice(0, 10) || formatDayStamp();
            const filePath = path.join(this.auditDir, `events-${dayStamp}.jsonl`);
            const line = `${JSON.stringify(record)}\n`;

            const next = this.writeQueue.then(() => fs.appendFile(filePath, line, "utf8"));
            this.writeQueue = next.catch((error) => {
                console.warn("[AuditLog] Append failed", error.message);
            });
        }

        return record;
    }

    async flush() {
        await this.writeQueue;
    }

    getRecent(filters = {}) {
        const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), MAX_RECENT_IN_MEMORY);
        const category = filters.category ? String(filters.category).trim().toLowerCase() : "";
        const linkedid = filters.linkedid ? String(filters.linkedid).trim() : "";
        const queue = filters.queue ? String(filters.queue).trim() : "";
        const search = filters.search ? String(filters.search).trim().toLowerCase() : "";

        const matched = [];

        for (let i = this.recentEntries.length - 1; i >= 0; i -= 1) {
            const item = this.recentEntries[i];
            if (category && String(item.category || "").toLowerCase() !== category) continue;
            if (linkedid && String(item.linkedid || "") !== linkedid) continue;
            if (queue && String(item.queue || "") !== queue) continue;
            if (search) {
                const haystack = JSON.stringify(item).toLowerCase();
                if (!haystack.includes(search)) continue;
            }
            matched.push(item);
            if (matched.length >= limit) break;
        }

        return matched;
    }

    async listDays() {
        if (!this.auditDir) {
            return [];
        }

        try {
            const entries = await fs.readdir(this.auditDir);
            return entries
                .map((name) => {
                    const m = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
                    return m ? m[1] : null;
                })
                .filter(Boolean)
                .sort()
                .reverse();
        } catch (_error) {
            return [];
        }
    }

    async readDay(dayStamp, filters = {}) {
        if (!this.auditDir || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayStamp || ""))) {
            return [];
        }

        const filePath = path.join(this.auditDir, `events-${dayStamp}.jsonl`);
        const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 1000);
        const category = filters.category ? String(filters.category).trim().toLowerCase() : "";
        const linkedid = filters.linkedid ? String(filters.linkedid).trim() : "";

        try {
            const raw = await fs.readFile(filePath, "utf8");
            const lines = raw.trim().split(/\r?\n/).filter(Boolean);
            const results = [];

            for (let i = lines.length - 1; i >= 0; i -= 1) {
                try {
                    const item = JSON.parse(lines[i]);
                    if (category && String(item.category || "").toLowerCase() !== category) continue;
                    if (linkedid && String(item.linkedid || "") !== linkedid) continue;
                    results.push(item);
                    if (results.length >= limit) break;
                } catch (_err) {
                    // skip malformed line
                }
            }

            return results;
        } catch (error) {
            if (error && error.code === "ENOENT") {
                return [];
            }
            throw error;
        }
    }

    async pruneExpiredFiles() {
        if (!this.auditDir) {
            return 0;
        }

        const cutoffMs = Date.now() - this.retentionDays * DAY_MS;
        let deleted = 0;

        try {
            const files = await fs.readdir(this.auditDir);
            for (const name of files) {
                const match = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
                if (!match) continue;
                const fileTimeMs = Date.parse(`${match[1]}T00:00:00.000Z`);
                if (Number.isFinite(fileTimeMs) && fileTimeMs < cutoffMs) {
                    await fs.unlink(path.join(this.auditDir, name));
                    deleted += 1;
                }
            }
        } catch (_error) {
            // non-fatal cleanup error
        }

        return deleted;
    }
}

const instance = new AuditLogService();

module.exports = instance;
module.exports.AuditLogService = AuditLogService;

