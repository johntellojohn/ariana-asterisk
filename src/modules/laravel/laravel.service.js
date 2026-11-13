const axios = require("axios");
const env = require("../../config/env");
const webhookDispatcher = require("./webhook-dispatcher.service");

function withTenantMetadata(payload = {}) {
    if (!env.laravelTenantDatabase || payload.database) {
        return payload;
    }

    return {
        ...payload,
        database: env.laravelTenantDatabase,
    };
}

function buildUrl(targetPath) {
    const baseUrl = String(env.laravelApiUrl || "").replace(/\/+$/, "");
    const cleanPath = String(targetPath || env.laravelTrunkEventsPath || "/api/trunk-calls/events").trim();
    const normalizedPath = cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;
    return `${baseUrl}${normalizedPath}`;
}

async function postDirectly(url, body, timeoutMs = env.laravelCallbackTimeoutMs) {
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
    };

    if (env.laravelApiToken) {
        headers.Authorization = `Bearer ${env.laravelApiToken}`;
    }

    const response = await axios.post(url, body, {
        headers,
        timeout: timeoutMs,
    });

    return {
        skipped: false,
        queued: false,
        status: response.status,
        data: response.data,
    };
}

async function sendTrunkCallEvent(payload, options = {}) {
    const force = Boolean(options && options.force);
    const immediate = Boolean(options && options.immediate);

    if (!force && !env.laravelTrunkEventsEnabled) {
        return { skipped: true, reason: "LARAVEL_TRUNK_EVENTS_ENABLED is false" };
    }

    if (!env.laravelApiUrl) {
        return { skipped: true, reason: "LARAVEL_API_URL is empty" };
    }

    const targetPath = (options && options.path) || env.laravelTrunkEventsPath || "/api/trunk-calls/events";
    const body = withTenantMetadata(payload);

    if (!immediate && webhookDispatcher.initialized) {
        const linkedid =
            (options && options.linkedid) ||
            body.linkedid ||
            body.external_call_id ||
            body.call_id ||
            body.uniqueid ||
            null;
        const dedupeKey = options && options.dedupeKey ? String(options.dedupeKey) : null;
        const result = webhookDispatcher.enqueue({
            path: targetPath,
            payload: body,
            linkedid,
            dedupeKey,
        });
        return {
            skipped: false,
            queued: true,
            deduped: result.deduped,
            outboxId: result.id,
        };
    }

    return postDirectly(buildUrl(targetPath), body, (options && options.timeoutMs) || env.laravelCallbackTimeoutMs);
}

async function pingEva(timeoutMs = 5000) {
    if (!env.laravelApiUrl || env.laravelApiUrl === "http://localhost") {
        return { ok: false, configured: false, latencyMs: 0, error: "LARAVEL_API_URL sin configurar" };
    }

    const url = buildUrl(env.laravelHeartbeatPath || "/api/trunk-calls/heartbeat");
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
    };
    if (env.laravelApiToken) {
        headers.Authorization = `Bearer ${env.laravelApiToken}`;
    }

    const startedAt = Date.now();
    try {
        const response = await axios.post(
            url,
            withTenantMetadata({ ping_only: true, sent_at: new Date().toISOString() }),
            { headers, timeout: timeoutMs }
        );
        return {
            ok: true,
            configured: true,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            endpointSupported: true,
        };
    } catch (error) {
        const status = error && error.response ? error.response.status : null;
        const latencyMs = Date.now() - startedAt;
        if (status === 404 || status === 405 || status === 422) {
            return {
                ok: true,
                configured: true,
                status,
                latencyMs,
                endpointSupported: status !== 404,
                note: status === 404 ? "EVA respondió en red (endpoint heartbeat aún pendiente de Fase 3)" : null,
            };
        }

        return {
            ok: false,
            configured: true,
            status,
            latencyMs,
            error: error && error.message ? error.message : "Error conectando con EVA",
        };
    }
}

module.exports = {
    sendTrunkCallEvent,
    pingEva,
    withTenantMetadata,
};
