const app = require("./app");
const env = require("./config/env");
const configStore = require("./modules/config/config-store.service");
const adminAuth = require("./modules/admin/admin-auth.service");
const auditLog = require("./modules/audit/audit-log.service");
const heartbeatService = require("./modules/audit/heartbeat.service");
const webhookDispatcher = require("./modules/laravel/webhook-dispatcher.service");
const ariService = require("./modules/ari/ari.service");
const ariBridgeService = require("./modules/ari/ari-bridge.service");
const { attachAriWebSocketServer } = require("./modules/ari/ari.websocket");
const { attachMobileWebSocketServer } = require("./modules/mobile/mobile.websocket");
const pbxService = require("./modules/pbx/pbx.service");
const { resolveGatewayCapabilities } = require("./modules/pbx/asterisk-capabilities");

let server = null;

async function bootstrap() {
    const configStatus = await configStore.init(env);
    await adminAuth.init({
        dataDir: env.dataDir,
        bootstrapUser: env.adminBootstrapUser,
        bootstrapPassword: env.adminBootstrapPassword,
        sessionSecret: env.adminSessionSecret,
        sessionTtlMs: env.adminSessionTtlMs,
    });
    await auditLog.init({
        dataDir: env.dataDir,
        retentionDays: env.auditRetentionDays,
    });
    await webhookDispatcher.init({
        dataDir: env.dataDir,
        maxItems: env.outboxMaxItems,
        maxConcurrency: env.outboxMaxConcurrency,
        historicalSyncThresholdMs: env.outboxHistoricalSyncThresholdMs,
        auditLogger: auditLog,
        getTargetConfig: () => ({
            enabled: Boolean(env.laravelTrunkEventsEnabled),
            baseUrl: env.laravelApiUrl,
            token: env.laravelApiToken,
            tenantDatabase: env.laravelTenantDatabase,
            timeoutMs: env.laravelCallbackTimeoutMs,
        }),
    });
    await heartbeatService.init({
        dataDir: env.dataDir,
        getTargetConfig: () => ({
            enabled: Boolean(env.laravelHeartbeatEnabled),
            baseUrl: env.laravelApiUrl,
            path: env.laravelHeartbeatPath,
            token: env.laravelApiToken,
            tenantDatabase: env.laravelTenantDatabase,
            timeoutMs: Math.min(env.laravelCallbackTimeoutMs || 10000, 10000),
        }),
        collectPayload: () => {
            const pbxStatus = pbxService.getStatus();
            const ariStatus = ariService.getStatus();
            const outboxStats = webhookDispatcher.getStats();
            const mem = process.memoryUsage();
            const capabilities = resolveGatewayCapabilities({
                ariStatus,
                pbxStatus,
                configuredAnswerMode: env.pbxAnswerMode,
                sipBridgeStatus: ariBridgeService.getStatus(),
            });
            return {
                gateway_version: env.buildVersion,
                uptime_seconds: Math.round(process.uptime()),
                configured: configStore.isConfigured(),
                ami_connected: Boolean(pbxStatus.connected),
                ari_connected: Boolean(ariStatus.connected),
                sip_bridge_available: Boolean(capabilities.sipBridgeAvailable),
                active_calls_count: Number(pbxStatus.activeCallsCount || 0),
                outbox_pending_count: Number(outboxStats.pendingCount || 0),
                outbox_online: Boolean(outboxStats.online),
                memory_rss_mb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
                memory_heap_used_mb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
                webhook_last_latency_ms: outboxStats.lastLatencyMs ?? null,
                webhook_avg_latency_ms: outboxStats.avgLatencyMs ?? null,
                asterisk_version: capabilities.asteriskVersion,
                asterisk_major: capabilities.asteriskMajor,
                asterisk_minor: capabilities.asteriskMinor,
                supports_external_media: capabilities.supportsExternalMedia,
                configured_answer_mode: capabilities.configuredAnswerMode,
                effective_answer_mode: capabilities.effectiveAnswerMode,
            };
        },
    });

    server = app.listen(env.port, () => {
        console.log(`${env.appName} running on port ${env.port}`, {
            buildVersion: env.buildVersion,
            ariBridgeWaitMs: env.ariBridgeWaitMs,
            trunkAiEnabled: env.trunkAiEnabled,
            configSource: configStatus.source,
            configured: configStatus.configured,
        });
    });

    if (configStore.isAmiReady()) {
        pbxService.start();
    } else {
        console.warn("[Bootstrap] AMI in pending-setup mode; configure PBX settings in /admin.", {
            pendingReasons: configStatus.pendingReasons,
        });
    }

    if (configStore.isAriReady()) {
        ariService.start();
    } else {
        console.warn("[Bootstrap] ARI in pending-setup mode; configure ARI settings in /admin.", {
            pendingReasons: configStatus.pendingReasons,
        });
    }

    if (configStore.isSipBridgeReady()) {
        ariBridgeService.start();
    } else if (env.sipBridgeEnabled) {
        console.warn("[Bootstrap] SIP Media Bridge habilitado pero falta configuracion ARI local.");
    }

    attachAriWebSocketServer(server);
    attachMobileWebSocketServer(server);
    heartbeatService.start(env.laravelHeartbeatIntervalMs);
}

bootstrap().catch((error) => {
    console.error("[Bootstrap] Fatal startup error", error);
    process.exit(1);
});

process.on("SIGTERM", shutdown("SIGTERM"));
process.on("SIGINT", shutdown("SIGINT"));

function shutdown(signal) {
    return () => {
        console.log(`${signal} received. Closing server...`);
        heartbeatService.stop();
        webhookDispatcher.stop();
        auditLog.stop();
        pbxService.stop();
        ariService.stop();
        ariBridgeService.stop();
        if (!server) {
            process.exit(0);
            return;
        }
        server.close(() => {
            console.log("Server closed.");
            process.exit(0);
        });
    };
}
