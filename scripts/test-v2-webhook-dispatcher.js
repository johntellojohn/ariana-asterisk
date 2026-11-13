const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { AuditLogService } = require("../src/modules/audit/audit-log.service");
const { WebhookDispatcherService } = require("../src/modules/laravel/webhook-dispatcher.service");

async function run() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ariana-v2-outbox-"));

    try {
        const audit = new AuditLogService();
        await audit.init({ dataDir: tempDir, retentionDays: 7 });

        // 1. FIFO ordering & dedupe during online delivery
        const deliveredOrder = [];
        const dispatcher = new WebhookDispatcherService();
        await dispatcher.init({
            dataDir: tempDir,
            historicalSyncThresholdMs: 500,
            auditLogger: audit,
            getTargetConfig: () => ({
                enabled: true,
                baseUrl: "http://eva.local",
                token: "tok-123",
                tenantDatabase: "sigcrm_test",
                timeoutMs: 2000,
            }),
            sender: async (_url, body) => {
                deliveredOrder.push({
                    linkedid: body.linkedid,
                    event: body.event_type,
                    historical: body.historical_sync,
                    database: body.database,
                });
                return { status: 200, data: { ok: true } };
            },
        });

        dispatcher.enqueue({
            linkedid: "call-1",
            dedupeKey: "INCOMING:call-1",
            payload: { linkedid: "call-1", event_type: "INCOMING" },
        });
        // Duplicate dedupeKey should be ignored
        const dup = dispatcher.enqueue({
            linkedid: "call-1",
            dedupeKey: "INCOMING:call-1",
            payload: { linkedid: "call-1", event_type: "INCOMING" },
        });
        assert.strictEqual(dup.deduped, true);

        dispatcher.enqueue({
            linkedid: "call-1",
            dedupeKey: "ENDED:call-1",
            payload: { linkedid: "call-1", event_type: "ENDED", is_terminal_event: true },
        });

        await dispatcher.flush();
        assert.deepStrictEqual(
            deliveredOrder.map((d) => d.event),
            ["INCOMING", "ENDED"]
        );
        assert.strictEqual(deliveredOrder[0].database, "sigcrm_test");
        assert.strictEqual(deliveredOrder[0].historical, false);
        dispatcher.stop();

        // 2. Offline persistence + recovery with historical_sync=true after threshold
        let wanOnline = false;
        const recoveredEvents = [];
        const offlineDispatcher = new WebhookDispatcherService();
        await offlineDispatcher.init({
            dataDir: tempDir,
            historicalSyncThresholdMs: 50,
            getTargetConfig: () => ({
                enabled: true,
                baseUrl: "http://eva.local",
                token: "tok-123",
                tenantDatabase: "sigcrm_test",
                timeoutMs: 1000,
            }),
            sender: async (_url, body) => {
                if (!wanOnline) {
                    const err = new Error("connect ETIMEDOUT");
                    throw err;
                }
                recoveredEvents.push(body);
                return { status: 200 };
            },
        });

        const oldOccurredAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        offlineDispatcher.enqueue({
            linkedid: "call-offline",
            dedupeKey: "ABANDONED:call-offline",
            payload: {
                linkedid: "call-offline",
                event_type: "ABANDONED",
                occurred_at: oldOccurredAt,
                is_terminal_event: true,
            },
        });

        await offlineDispatcher.flush();
        assert.strictEqual(offlineDispatcher.getStats().online, false);
        assert.strictEqual(offlineDispatcher.getStats().pendingCount, 1);

        // Verify outbox persisted on disk while offline
        const persistedRaw = await fs.readFile(path.join(tempDir, "outbox.json"), "utf8");
        assert.ok(persistedRaw.includes("call-offline"));
        offlineDispatcher.stop();

        // Simulate restart & WAN recovery in a new dispatcher instance loading from disk
        wanOnline = true;
        const restartedDispatcher = new WebhookDispatcherService();
        await restartedDispatcher.init({
            dataDir: tempDir,
            historicalSyncThresholdMs: 50,
            getTargetConfig: () => ({
                enabled: true,
                baseUrl: "http://eva.local",
                token: "tok-123",
                tenantDatabase: "sigcrm_test",
                timeoutMs: 1000,
            }),
            sender: async (_url, body) => {
                recoveredEvents.push(body);
                return { status: 200 };
            },
        });

        await restartedDispatcher.flush();
        assert.strictEqual(recoveredEvents.length, 1);
        assert.strictEqual(recoveredEvents[0].linkedid, "call-offline");
        assert.strictEqual(recoveredEvents[0].historical_sync, true);
        assert.strictEqual(recoveredEvents[0].occurred_at, oldOccurredAt);
        assert.strictEqual(restartedDispatcher.getStats().pendingCount, 0);
        assert.strictEqual(restartedDispatcher.getStats().online, true);

        await audit.flush();
        const days = await audit.listDays();
        assert.strictEqual(days.length >= 1, true);
        const recentAudit = audit.getRecent({ linkedid: "call-1" });
        assert.strictEqual(recentAudit.length, 2);

        restartedDispatcher.stop();
        audit.stop();
        console.log("v2 webhook-dispatcher & audit-log tests passed");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});

