const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { CallStateService } = require("../src/modules/pbx/call-state.service");
const { WebhookDispatcherService } = require("../src/modules/laravel/webhook-dispatcher.service");
const { HeartbeatService } = require("../src/modules/audit/heartbeat.service");

function parseArgs(argv) {
    const args = {
        burst: 10,
        evaUrl: "",
        token: "",
        database: "",
        offlineTest: true,
    };

    for (const raw of argv) {
        if (raw.startsWith("--burst=")) {
            args.burst = Math.max(1, Number(raw.slice("--burst=".length)) || 10);
        } else if (raw.startsWith("--eva-url=")) {
            args.evaUrl = raw.slice("--eva-url=".length).trim();
        } else if (raw.startsWith("--token=")) {
            args.token = raw.slice("--token=".length).trim();
        } else if (raw.startsWith("--database=")) {
            args.database = raw.slice("--database=".length).trim();
        } else if (raw === "--no-offline-test") {
            args.offlineTest = false;
        }
    }

    return args;
}

function toLaravelTrunkPayload(decision, event, stateCall) {
    const mappedStatus =
        stateCall.status === "ENDED"
            ? "HANGUP"
            : stateCall.status === "ABANDONED"
                ? "ABANDONED"
                : stateCall.status === "ANSWERED"
                    ? "ANSWER"
                    : stateCall.status;

    return {
        linkedid: stateCall.linkedid,
        event_type: mappedStatus,
        is_terminal_event: Boolean(decision.isTerminal),
        occurred_at: event.timestamp,
        event: {
            ...event,
            event: decision.emitEventName || event.event,
            time: event.timestamp,
            timestamp: event.timestamp,
            occurred_at: event.timestamp,
        },
        summary: {
            linkedid: stateCall.linkedid,
            firstEventTime: stateCall.firstEventAt,
            lastEventTime: stateCall.lastEventAt,
            queueJoinedAt: stateCall.queueJoinedAt,
            ringStartedAt: stateCall.ringStartedAt,
            answeredAt: stateCall.answeredAt,
            endedAt: stateCall.endedAt,
            from: stateCall.callerNumber || event.caller || "",
            to: stateCall.targetExtension || stateCall.queue || "",
            callerName: stateCall.callerName || "",
            queue: stateCall.queue || "",
            status: mappedStatus,
            answered: Boolean(stateCall.answered),
            bridged: Boolean(stateCall.bridged),
            result: mappedStatus.toLowerCase(),
        },
        source: "ariana-asterisk-v2-e2e-simulator",
    };
}

async function startMockEvaServer() {
    const receivedEvents = [];
    const receivedHeartbeats = [];

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            let body = {};
            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            } catch (_error) {
                body = {};
            }

            if (req.url === "/api/trunk-calls/heartbeat") {
                receivedHeartbeats.push(body);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, data: body }));
                return;
            }

            if (req.url === "/api/trunk-calls/events") {
                receivedEvents.push(body);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, data: { linkedid: body.linkedid } }));
                return;
            }

            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    return {
        url: `http://127.0.0.1:${addr.port}`,
        receivedEvents,
        receivedHeartbeats,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

async function run() {
    const args = parseArgs(process.argv.slice(2));
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ariana-v2-e2e-"));
    const mockEva = args.evaUrl ? null : await startMockEvaServer();
    const baseUrl = args.evaUrl || mockEva.url;
    const token = args.token || "sim-token";

    let rawAmiEvents = 0;
    let totalEmitted = 0;

    try {
        const callState = new CallStateService();
        const dispatcher = new WebhookDispatcherService();
        const heartbeat = new HeartbeatService();

        await dispatcher.init({
            dataDir: tempDir,
            historicalSyncThresholdMs: 5 * 60 * 1000,
            getTargetConfig: () => ({
                enabled: true,
                baseUrl,
                token,
                tenantDatabase: args.database || undefined,
                timeoutMs: 10000,
            }),
        });

        await heartbeat.init({
            dataDir: tempDir,
            getTargetConfig: () => ({
                enabled: true,
                baseUrl,
                path: "/api/trunk-calls/heartbeat",
                token,
                tenantDatabase: args.database || undefined,
                timeoutMs: 5000,
            }),
            collectPayload: () => ({
                gateway_version: "ari-ai-trunk-v2",
                uptime_seconds: Math.round(process.uptime()),
                configured: true,
                ami_connected: true,
                ari_connected: true,
                active_calls_count: callState.getActiveCount(),
                outbox_pending_count: dispatcher.getStats().pendingCount,
                outbox_online: dispatcher.getStats().online,
                memory_rss_mb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10,
                webhook_last_latency_ms: dispatcher.getStats().lastLatencyMs,
                webhook_avg_latency_ms: dispatcher.getStats().avgLatencyMs,
            }),
        });

        const feed = (rawEvent) => {
            rawAmiEvents += 1;
            const decision = callState.processEvent(rawEvent);
            if (!decision || !decision.emit || !decision.call) {
                return decision;
            }
            totalEmitted += 1;
            const payload = toLaravelTrunkPayload(decision, rawEvent, decision.call);
            dispatcher.enqueue({
                linkedid: decision.call.linkedid,
                dedupeKey: decision.dedupeKey,
                payload,
            });
            return decision;
        };

        // Scenario A + D: Burst of N calls (50% abandoned at 3s, 50% answered and ended)
        const baseTs = Date.now() - 30000;
        for (let i = 1; i <= args.burst; i += 1) {
            const lid = `sim-burst-${Date.now()}-${i}`;
            const callerChan = `Local/09910000${String(i).padStart(2, "0")}@simulador-cola-0001;2`;
            const agentExt = i % 2 === 0 ? "150" : "101";
            const agentChan = `Local/${agentExt}@simulador-agente-0001;1`;
            const t0 = new Date(baseTs + i * 100).toISOString();
            const t1 = new Date(baseTs + i * 100 + 1000).toISOString();
            const t2 = new Date(baseTs + i * 100 + 3000).toISOString();
            const t3 = new Date(baseTs + i * 100 + 15000).toISOString();

            feed({ linkedid: lid, event: "Newchannel", channel: callerChan, caller: `0991000${i}`, timestamp: t0 });
            feed({ linkedid: lid, event: "VarSet", channel: callerChan, timestamp: t0 });
            feed({ linkedid: lid, event: "QueueCallerJoin", channel: callerChan, queue: "650", callerIdNum: `0991000${i}`, timestamp: t0 });
            feed({ linkedid: lid, event: "AgentCalled", channel: callerChan, destChannel: agentChan, queue: "650", timestamp: t1 });
            feed({ linkedid: lid, event: "DialBegin", channel: callerChan, destChannel: agentChan, destExtension: agentExt, timestamp: t1 });

            if (i % 2 === 1) {
                // Abandonment at 3s
                feed({ linkedid: lid, event: "DialEnd", channel: callerChan, destChannel: agentChan, dialStatus: "CANCEL", timestamp: t2 });
                feed({ linkedid: lid, event: "Hangup", channel: agentChan, timestamp: t2 });
                feed({ linkedid: lid, event: "Hangup", channel: callerChan, cause: "16", causeTxt: "Normal Clearing", timestamp: t2 });
            } else {
                // Answered + Hangup
                feed({ linkedid: lid, event: "AgentConnect", channel: callerChan, destChannel: agentChan, timestamp: t2 });
                feed({ linkedid: lid, event: "Hangup", channel: callerChan, cause: "16", causeTxt: "Normal Clearing", timestamp: t3 });
            }
        }

        // Scenario C: Agent rotation 101 -> 150 without false hangup
        const rotLid = `sim-rot-${Date.now()}`;
        const rotCaller = "Local/099888777@simulador-cola-0009;2";
        feed({ linkedid: rotLid, event: "QueueCallerJoin", channel: rotCaller, queue: "650", callerIdNum: "099888777", timestamp: new Date(baseTs).toISOString() });
        feed({ linkedid: rotLid, event: "AgentCalled", channel: rotCaller, destChannel: "Local/101@simulador-agente-0009;1", queue: "650", timestamp: new Date(baseTs + 1000).toISOString() });
        feed({ linkedid: rotLid, event: "AgentRingNoAnswer", channel: rotCaller, destChannel: "Local/101@simulador-agente-0009;1", queue: "650", timestamp: new Date(baseTs + 11000).toISOString() });
        feed({ linkedid: rotLid, event: "Hangup", channel: "Local/101@simulador-agente-0009;1", timestamp: new Date(baseTs + 11050).toISOString() });
        assert.strictEqual(callState.getCall(rotLid).status, "RINGING");
        feed({ linkedid: rotLid, event: "AgentCalled", channel: rotCaller, destChannel: "Local/150@simulador-agente-0009;1", queue: "650", timestamp: new Date(baseTs + 12000).toISOString() });
        feed({ linkedid: rotLid, event: "AgentConnect", channel: rotCaller, destChannel: "Local/150@simulador-agente-0009;1", timestamp: new Date(baseTs + 14000).toISOString() });
        feed({ linkedid: rotLid, event: "Hangup", channel: rotCaller, cause: "16", timestamp: new Date(baseTs + 34000).toISOString() });

        await dispatcher.flush();

        // Scenario E (optional historical sync check on offline outage simulation)
        if (args.offlineTest && !args.evaUrl) {
            const oldTime = new Date(Date.now() - 8 * 60 * 1000).toISOString();
            const offlineLid = `sim-offline-${Date.now()}`;
            feed({ linkedid: offlineLid, event: "QueueCallerJoin", channel: "SIP/telco-01", queue: "650", callerIdNum: "099555000", timestamp: oldTime });
            feed({ linkedid: offlineLid, event: "Hangup", channel: "SIP/telco-01", cause: "16", timestamp: oldTime });
            await dispatcher.flush();
            const synced = mockEva.receivedEvents.find((ev) => ev.linkedid === offlineLid);
            assert.ok(synced && synced.historical_sync === true, "Expected historical_sync=true for delayed offline event");
        }

        const hbResult = await heartbeat.sendOnce();
        assert.strictEqual(hbResult.ok, true, `Heartbeat failed: ${JSON.stringify(hbResult)}`);

        const stats = dispatcher.getStats();
        assert.strictEqual(stats.pendingCount, 0, "Expected outbox to drain completely");
        assert.strictEqual(stats.deadLetterCount, 0, "Expected zero permanent HTTP failures");
        assert.strictEqual(callState.getActiveCount(), 0, "Expected zero stuck active calls");

        const reductionPct = Math.round(((rawAmiEvents - totalEmitted) / rawAmiEvents) * 100);
        console.log(JSON.stringify({
            ok: true,
            targetUrl: baseUrl,
            burstCalls: args.burst,
            rawAmiEvents,
            webhookPostsSent: stats.deliveredCount,
            noiseReductionPct: reductionPct,
            avgWebhookLatencyMs: stats.avgLatencyMs,
            activeCallsRemaining: callState.getActiveCount(),
            outboxPending: stats.pendingCount,
            heartbeatSent: hbResult,
        }, null, 2));

        dispatcher.stop();
        heartbeat.stop();
    } finally {
        if (mockEva) {
            await mockEva.close();
        }
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
