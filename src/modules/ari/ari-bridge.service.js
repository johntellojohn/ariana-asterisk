const crypto = require("crypto");

const env = require("../../config/env");
const { createAriClient } = require("./ari-client.factory");

const TOKEN_TTL_MS = 10 * 60 * 1000;
const bridgeTokens = new Map();

function pruneExpiredTokens() {
    const now = Date.now();
    for (const [token, entry] of bridgeTokens.entries()) {
        if (!entry || now - entry.createdAtMs > TOKEN_TTL_MS) {
            bridgeTokens.delete(token);
        }
    }
}

function registerBridgeToken(linkedid, metadata = {}) {
    pruneExpiredTokens();

    const canonical = String(linkedid || "").trim();
    if (!canonical) {
        const error = new Error("linkedid is required to register bridge token");
        error.status = 422;
        throw error;
    }

    let token = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = `88${crypto.randomInt(10000000, 99999999)}`;
        if (!bridgeTokens.has(candidate)) {
            token = candidate;
            break;
        }
    }

    if (!token) {
        token = `88${Date.now().toString().slice(-8)}`;
    }

    bridgeTokens.set(token, {
        linkedid: canonical,
        createdAtMs: Date.now(),
        agentId: metadata.agentId || null,
        pbxChannel: metadata.pbxChannel || null,
    });

    ariBridgeClient.registerLinkedIdAlias(token, canonical);

    return token;
}

function resolveBridgeToken(tokenOrCandidate) {
    const clean = String(tokenOrCandidate || "").trim();
    if (!clean) {
        return null;
    }

    const entry = bridgeTokens.get(clean);
    if (!entry) {
        return null;
    }

    if (Date.now() - entry.createdAtMs > TOKEN_TTL_MS) {
        bridgeTokens.delete(clean);
        return null;
    }

    return entry;
}

function releaseBridgeToken(token) {
    const clean = String(token || "").trim();
    if (clean) {
        bridgeTokens.delete(clean);
    }
}

function resolveCustomLinkedId(channel = {}, event = null) {
    const candidates = [];

    if (Array.isArray(event?.args)) {
        candidates.push(...event.args);
    }
    if (channel?.dialplan?.exten) {
        candidates.push(channel.dialplan.exten);
    }
    if (channel?.caller?.number) {
        candidates.push(channel.caller.number);
    }
    if (channel?.connected?.number) {
        candidates.push(channel.connected.number);
    }

    for (const candidate of candidates) {
        const entry = resolveBridgeToken(candidate);
        if (entry?.linkedid) {
            return entry.linkedid;
        }
    }

    return null;
}

const ariBridgeClient = createAriClient({
    logTag: "ari:bridge",
    getConfig: () => ({
        enabled: env.sipBridgeEnabled,
        baseUrl: env.sipBridgeAriBaseUrl,
        wsUrl: "",
        username: env.sipBridgeAriUsername,
        password: env.sipBridgeAriPassword,
        appName: env.sipBridgeAriAppName || "ariana-bridge",
        buildVersion: env.buildVersion,
        reconnectMs: env.ariReconnectMs,
        requestTimeoutMs: env.ariRequestTimeoutMs,
        maxEvents: env.ariMaxEvents,
        laravelEventsEnabled: false,
        autoAnswer: false,
        autoBridge: false,
        autoPlaybackMedia: "",
        bridgeWaitMs: env.sipBridgeWaitMs || env.ariBridgeWaitMs,
        stasisWaitMs: env.sipBridgeWaitMs || env.ariStasisWaitMs,
    }),
    notifyLaravelFn: null,
    resolveCustomLinkedId,
});

function isAvailable() {
    const status = ariBridgeClient.getStatus();
    return Boolean(status.enabled && status.connected);
}

function getBridgeStatus() {
    return {
        ...ariBridgeClient.getStatus(),
        available: isAvailable(),
        dialContext: env.sipBridgeDialContext || "ariana-sip-bridge",
        rtpHost: env.sipBridgeRtpHost || "api",
        activeTokensCount: bridgeTokens.size,
    };
}

module.exports = {
    ...ariBridgeClient,
    getStatus: getBridgeStatus,
    isAvailable,
    registerBridgeToken,
    resolveBridgeToken,
    releaseBridgeToken,
    __test: {
        clearTokens: () => bridgeTokens.clear(),
    },
};

