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
        assert.strictEqual(typeof dispatcher.getStats().lastLatencyMs, "number");
        assert.strictEqual(typeof dispatcher.getStats().avgLatencyMs, "number");
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

        // 3. Per-linkedid strict FIFO with cross-call parallel lanes
        const parallelDir = path.join(tempDir, "parallel");
        const parallelDispatcher = new WebhookDispatcherService();
        let activeRequests = 0;
        let peakConcurrent = 0;
        const call1Timeline = [];

        await parallelDispatcher.init({
            dataDir: parallelDir,
            maxConcurrency: 4,
            getTargetConfig: () => ({
                enabled: true,
                baseUrl: "http://eva.local",
                token: "tok-123",
                tenantDatabase: "sigcrm_test",
                timeoutMs: 2000,
            }),
            sender: async (_url, body) => {
                activeRequests += 1;
                peakConcurrent = Math.max(peakConcurrent, activeRequests);
                if (body.linkedid === "call-p1") {
                    call1Timeline.push(`start:${body.event_type}`);
                }
                await new Promise((resolve) => setTimeout(resolve, 60));
                if (body.linkedid === "call-p1") {
                    call1Timeline.push(`end:${body.event_type}`);
                }
                activeRequests -= 1;
                return { status: 200 };
            },
        });

        for (const id of ["call-p1", "call-p2", "call-p3", "call-p4"]) {
            parallelDispatcher.enqueue({
                linkedid: id,
                dedupeKey: `INCOMING:${id}`,
                payload: { linkedid: id, event_type: "INCOMING" },
            });
        }
        parallelDispatcher.enqueue({
            linkedid: "call-p1",
            dedupeKey: "TERMINAL:call-p1",
            payload: { linkedid: "call-p1", event_type: "TERMINAL", is_terminal_event: true },
        });

        const startedParallel = Date.now();
        await parallelDispatcher.flush();
        const parallelElapsed = Date.now() - startedParallel;
        parallelDispatcher.stop();

        assert.strictEqual(peakConcurrent, 4, `Expected 4 parallel call lanes, got ${peakConcurrent}`);
        assert.deepStrictEqual(call1Timeline, [
            "start:INCOMING",
            "end:INCOMING",
            "start:TERMINAL",
            "end:TERMINAL",
        ]);
        assert.ok(parallelElapsed < 240, `Expected <240ms parallel burst, got ${parallelElapsed}ms`);

        // 4. Caja Negra audit log captures nested queue, caller and agentExtension from pbx webhook payload
        const nestedAudit = new AuditLogService();
        const nestedDir = path.join(tempDir, "nested-audit");
        await nestedAudit.init({ dataDir: nestedDir, retentionDays: 7 });
        const nestedDispatcher = new WebhookDispatcherService();
        await nestedDispatcher.init({
            dataDir: nestedDir,
            auditLogger: nestedAudit,
            getTargetConfig: () => ({
                enabled: true,
                baseUrl: "http://eva.local",
                token: "tok-123",
                tenantDatabase: "sigcrm_test",
                timeoutMs: 2000,
            }),
            sender: async () => ({ status: 200, data: { ok: true } }),
        });

        nestedDispatcher.enqueue({
            linkedid: "1795010000.7",
            dedupeKey: "ANSWERED:1795010000.7",
            payload: {
                linkedid: "1795010000.7",
                event_type: "ANSWER",
                event: {
                    event: "agentconnect",
                    caller: "0987654321",
                    queue: "650",
                    agentExtension: "101",
                },
                summary: {
                    from: "0987654321",
                    to: "101",
                    queue: "650",
                },
            },
        });
        await nestedDispatcher.flush();
        nestedDispatcher.stop();

        const auditRows = nestedAudit.getRecent({ linkedid: "1795010000.7" });
        assert.strictEqual(auditRows.length, 1);
        assert.strictEqual(auditRows[0].caller, "0987654321");
        assert.strictEqual(auditRows[0].queue, "650");
        assert.strictEqual(auditRows[0].agentExtension, "101");

        console.log("v2 webhook-dispatcher & audit-log tests passed");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});

