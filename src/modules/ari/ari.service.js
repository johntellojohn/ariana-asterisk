const axios = require("axios");
const EventEmitter = require("events");
const WebSocket = require("ws");

const env = require("../../config/env");
const laravelService = require("../laravel/laravel.service");

let ws = null;
let started = false;
let connected = false;
let reconnectTimer = null;
let lastConnectAttemptAt = null;
let lastEventTime = null;
let lastError = null;

const sessionsByChannelId = new Map();
const ariEvents = [];
const sessionEvents = new EventEmitter();

sessionEvents.setMaxListeners(50);

function start() {
    if (!env.ariEnabled) {
        return getStatus();
    }

    if (started) {
        return getStatus();
    }

    started = true;

    if (!env.ariUsername || !env.ariPassword) {
        lastError = "ARI credentials are missing";
        return getStatus();
    }

    connectWebSocket();

    return getStatus();
}

function stop() {
    started = false;
    connected = false;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (ws) {
        ws.removeAllListeners();
        ws.close();
        ws = null;
    }
}

function connectWebSocket() {
    if (!started || !env.ariEnabled) {
        return;
    }

    if (ws) {
        ws.removeAllListeners();
        ws.close();
        ws = null;
    }

    lastConnectAttemptAt = new Date().toISOString();

    try {
        ws = new WebSocket(buildEventsUrl(), {
            headers: {
                Authorization: basicAuthHeader(),
            },
        });
    } catch (error) {
        connected = false;
        lastError = error.message;
        scheduleReconnect();
        return;
    }

    ws.on("open", () => {
        connected = true;
        lastError = null;
        console.log(`[ari] connected to ${safeBaseUrl()} app=${env.ariAppName}`);
    });

    ws.on("message", (message) => {
        handleRawEvent(message).catch((error) => {
            lastError = error.message;
            console.error("[ari] event handling failed", {
                message: error.message,
            });
        });
    });

    ws.on("close", (code, reason) => {
        connected = false;
        console.warn("[ari] websocket closed", {
            code,
            reason: reason ? reason.toString() : "",
        });
        scheduleReconnect();
    });

    ws.on("error", (error) => {
        connected = false;
        lastError = error.message;
        console.error("[ari] websocket error", {
            message: error.message,
        });
    });
}

function scheduleReconnect() {
    if (!started || !env.ariEnabled || reconnectTimer) {
        return;
    }

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
    }, env.ariReconnectMs);
}

async function handleRawEvent(message) {
    const event = JSON.parse(Buffer.isBuffer(message) ? message.toString("utf8") : String(message));
    rememberEvent(event);

    const type = String(event.type || "");
    const channel = event.channel || {};

    switch (type) {
        case "StasisStart": {
            const session = upsertSession(channel, {
                status: "stasis",
                startedAt: event.timestamp || new Date().toISOString(),
                stasisArgs: Array.isArray(event.args) ? event.args : [],
            });
            rememberSessionEvent(session, event);
            notifyLaravel(session, event, "dialbegin");
            runAutoFlow(session).catch((error) => {
                session.lastError = error.message;
                console.error("[ari] auto flow failed", {
                    channelId: session.channelId,
                    message: error.message,
                });
            });
            break;
        }

        case "ChannelStateChange": {
            const session = upsertSession(channel);
            session.status = channel.state === "Up" ? "answered" : session.status;
            rememberSessionEvent(session, event);
            if (channel.state === "Up") {
                notifyLaravel(session, event, "dialend", "ANSWER");
            }
            break;
        }

        case "ChannelEnteredBridge": {
            const session = upsertSession(channel, {
                status: "bridged",
                bridgeId: event.bridge?.id || null,
            });
            rememberSessionEvent(session, event);
            notifyLaravel(session, event, "bridgeenter");
            break;
        }

        case "ChannelLeftBridge": {
            const session = upsertSession(channel);
            session.bridgeId = null;
            rememberSessionEvent(session, event);
            break;
        }

        case "StasisEnd":
        case "ChannelDestroyed": {
            const session = upsertSession(channel, {
                status: "ended",
                endedAt: event.timestamp || new Date().toISOString(),
            });
            rememberSessionEvent(session, event);
            notifyLaravel(session, event, "hangup");
            break;
        }

        default:
            if (channel.id && sessionsByChannelId.has(channel.id)) {
                rememberSessionEvent(sessionsByChannelId.get(channel.id), event);
            }
            break;
    }
}

async function runAutoFlow(session) {
    if (env.ariAutoAnswer) {
        await answerSession(session.channelId);
    }

    if (env.ariAutoBridge) {
        await ensureBridge(session.channelId);
    }

    if (env.ariAutoPlaybackMedia) {
        await playMedia(session.channelId, env.ariAutoPlaybackMedia);
    }
}

async function answerSession(channelId) {
    const session = requireSession(channelId);

    if (session.answeredAt || session.channel?.state === "Up") {
        session.status = "answered";
        session.answeredAt = session.answeredAt || new Date().toISOString();
        session.updatedAt = session.answeredAt;

        return snapshotSession(session);
    }

    try {
        await ariRequest("post", `/channels/${encodeURIComponent(channelId)}/answer`);
    } catch (error) {
        if (error.response?.status !== 422) {
            throw error;
        }
    }

    session.status = "answered";
    session.answeredAt = new Date().toISOString();
    session.updatedAt = session.answeredAt;

    notifyLaravel(session, { type: "ArianaAnswer", channel: session.channel }, "dialend", "ANSWER");

    return snapshotSession(session);
}

async function answerCallByLinkedId(linkedid) {
    const session = requireSessionByLinkedId(linkedid);

    return answerSession(session.channelId);
}

async function ensureBridge(channelId) {
    const session = requireSession(channelId);

    if (!session.bridgeId) {
        const response = await ariRequest("post", "/bridges", {
            params: {
                type: "mixing",
                name: `ariana-${channelId}`,
            },
        });

        session.bridgeId = response.data?.id || response.data?.bridge?.id || session.bridgeId;
    }

    if (!session.bridgeId) {
        const error = new Error("ARI bridge was not created");
        error.status = 502;
        throw error;
    }

    await addChannelToBridgeWithRetry(session.bridgeId, channelId);

    session.status = "bridged";
    session.updatedAt = new Date().toISOString();

    return snapshotSession(session);
}

async function ensureCallBridgeByLinkedId(linkedid) {
    const session = requireSessionByLinkedId(linkedid);

    return ensureBridge(session.channelId);
}

async function playMedia(channelId, media) {
    const session = requireSession(channelId);
    const targetMedia = normalizeMedia(media);

    const response = await ariRequest("post", `/channels/${encodeURIComponent(channelId)}/play`, {
        params: {
            media: targetMedia,
        },
    });

    session.lastPlaybackId = response.data?.id || null;
    session.updatedAt = new Date().toISOString();

    return {
        session: snapshotSession(session),
        playback: response.data || null,
    };
}

async function playCallMediaByLinkedId(linkedid, media) {
    const session = requireSessionByLinkedId(linkedid);

    return playMedia(session.channelId, media);
}

async function hangupSession(channelId, reason = "normal") {
    const session = requireSession(channelId);

    await ariRequest("delete", `/channels/${encodeURIComponent(channelId)}`, {
        params: {
            reason,
        },
    });

    session.status = "ended";
    session.endedAt = new Date().toISOString();
    session.updatedAt = session.endedAt;

    return snapshotSession(session);
}

async function hangupCallByLinkedId(linkedid, reason = "normal") {
    const session = requireSessionByLinkedId(linkedid);

    return hangupSession(session.channelId, reason);
}

async function ariRequest(method, path, options = {}) {
    ensureReady();

    return axios.request({
        method,
        url: `${restBaseUrl()}${path}`,
        auth: {
            username: env.ariUsername,
            password: env.ariPassword,
        },
        timeout: env.ariRequestTimeoutMs,
        params: options.params,
        data: options.data,
        headers: {
            Accept: "application/json",
        },
    });
}

function getStatus() {
    return {
        enabled: env.ariEnabled,
        started,
        connected,
        baseUrl: safeBaseUrl(),
        appName: env.ariAppName,
        buildVersion: env.buildVersion,
        bridgeWaitMs: env.ariBridgeWaitMs,
        stasisWaitMs: env.ariStasisWaitMs,
        lastConnectAttemptAt,
        lastEventTime,
        lastError,
        activeSessions: Array.from(sessionsByChannelId.values())
            .filter((session) => session.status !== "ended")
            .length,
        totalSessions: sessionsByChannelId.size,
    };
}

function listSessions() {
    return Array.from(sessionsByChannelId.values())
        .map(snapshotSession)
        .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt));
}

function getSession(channelId) {
    const session = sessionsByChannelId.get(channelId);

    return session ? snapshotSession(session) : null;
}

function getSessionByLinkedId(linkedid) {
    const session = findSessionByLinkedId(linkedid);

    return session ? snapshotSession(session) : null;
}

function getEvents() {
    return [...ariEvents];
}

function onSessionEvent(listener) {
    sessionEvents.on("session-event", listener);

    return () => sessionEvents.off("session-event", listener);
}

function upsertSession(channel, attributes = {}) {
    const channelId = channel.id;

    if (!channelId) {
        const error = new Error("ARI channel event does not include channel.id");
        error.status = 422;
        throw error;
    }

    const now = new Date().toISOString();
    const existing = sessionsByChannelId.get(channelId);
    const session = existing || {
        id: channelId,
        channelId,
        linkedid: channel.linkedid || channel.id,
        status: "created",
        createdAt: now,
        updatedAt: now,
        answeredAt: null,
        endedAt: null,
        bridgeId: null,
        lastPlaybackId: null,
        lastError: null,
        stasisArgs: [],
        channel: normalizeChannel(channel),
        events: [],
    };

    session.linkedid = channel.linkedid || session.linkedid || channel.id;
    session.channel = normalizeChannel(channel);
    session.updatedAt = now;

    if (channel.state === "Up" && !session.answeredAt) {
        session.status = "answered";
        session.answeredAt = now;
    }

    Object.assign(session, attributes);
    sessionsByChannelId.set(channelId, session);

    return session;
}

function rememberSessionEvent(session, event) {
    const summary = summarizeEvent(event);

    session.events.push(summary);

    while (session.events.length > env.ariMaxEvents) {
        session.events.shift();
    }

    sessionEvents.emit("session-event", snapshotSession(session), summary, event);
}

function rememberEvent(event) {
    lastEventTime = event.timestamp || new Date().toISOString();

    ariEvents.push(summarizeEvent(event));

    while (ariEvents.length > env.ariMaxEvents) {
        ariEvents.shift();
    }
}

function summarizeEvent(event) {
    const channel = event.channel || {};
    const bridge = event.bridge || {};

    return {
        time: event.timestamp || new Date().toISOString(),
        type: event.type || "",
        application: event.application || "",
        channelId: channel.id || "",
        channelName: channel.name || "",
        channelState: channel.state || "",
        bridgeId: bridge.id || "",
        args: Array.isArray(event.args) ? event.args : [],
    };
}

function snapshotSession(session) {
    return {
        id: session.id,
        channelId: session.channelId,
        linkedid: session.linkedid,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        answeredAt: session.answeredAt,
        endedAt: session.endedAt,
        bridgeId: session.bridgeId,
        lastPlaybackId: session.lastPlaybackId,
        lastError: session.lastError,
        stasisArgs: [...session.stasisArgs],
        channel: { ...session.channel },
        events: [...session.events],
    };
}

function normalizeChannel(channel = {}) {
    return {
        id: channel.id || "",
        name: channel.name || "",
        state: channel.state || "",
        callerNumber: channel.caller?.number || "",
        callerName: channel.caller?.name || "",
        connectedNumber: channel.connected?.number || "",
        connectedName: channel.connected?.name || "",
        accountcode: channel.accountcode || "",
        creationtime: channel.creationtime || "",
        language: channel.language || "",
        dialplanContext: channel.dialplan?.context || "",
        dialplanExten: channel.dialplan?.exten || "",
        dialplanPriority: channel.dialplan?.priority || "",
    };
}

function notifyLaravel(session, event, trunkEventName, dialStatus = "") {
    if (!env.ariLaravelEventsEnabled) {
        return;
    }

    const eventPayload = toTrunkEvent(session, event, trunkEventName, dialStatus);
    const payload = {
        event: eventPayload,
        summary: toTrunkSummary(session, eventPayload),
        source: "ariana-asterisk-ari",
    };

    laravelService
        .sendTrunkCallEvent(payload)
        .then((response) => {
            console.log("[ari:laravel] trunk event accepted", {
                linkedid: session.linkedid,
                event: trunkEventName,
                response,
            });
        })
        .catch((error) => {
            console.error("[ari] Laravel trunk event callback failed", {
                linkedid: session.linkedid,
                event: trunkEventName,
                message: error.message,
                status: error.response?.status,
            });
        });
}

function toTrunkEvent(session, event, trunkEventName, dialStatus = "") {
    const channel = session.channel || {};

    return {
        time: event.timestamp || new Date().toISOString(),
        event: trunkEventName,
        caller: channel.callerNumber || channel.callerName || "",
        callerName: channel.callerName || "",
        channel: channel.name || session.channelId,
        destination: channel.dialplanExten || "",
        destChannel: "",
        dialStatus,
        bridgeUniqueid: session.bridgeId || "",
        uniqueid: session.channelId,
        linkedid: session.linkedid || session.channelId,
        cause: event.cause || "",
        causeTxt: event.cause_txt || event.causeTxt || "",
    };
}

function toTrunkSummary(session, eventPayload) {
    const ended = session.status === "ended";
    const bridged = Boolean(session.bridgeId) || session.status === "bridged";
    const answered = Boolean(session.answeredAt) || ["answered", "bridged"].includes(session.status);

    return {
        linkedid: session.linkedid,
        firstEventTime: session.startedAt || session.createdAt,
        lastEventTime: session.updatedAt,
        from: eventPayload.caller,
        to: eventPayload.destination,
        callerName: eventPayload.callerName,
        status: ended ? "HANGUP" : answered ? "ANSWER" : "IN_PROGRESS",
        answered,
        bridged,
        result: ended ? "hangup" : answered ? "answered" : "in_progress",
        channels: [eventPayload.channel].filter(Boolean),
        totalEvents: session.events.length,
    };
}

function requireSession(channelId) {
    const session = sessionsByChannelId.get(channelId);

    if (!session) {
        const error = new Error("ARI session not found");
        error.status = 404;
        throw error;
    }

    return session;
}

function requireSessionByLinkedId(linkedid) {
    const session = findSessionByLinkedId(linkedid);

    if (!session) {
        const error = new Error("ARI session not found for linkedid");
        error.status = 404;
        throw error;
    }

    return session;
}

async function addChannelToBridgeWithRetry(bridgeId, channelId) {
    const startedAt = Date.now();
    const maxWait = Math.max(0, Number(env.ariBridgeWaitMs || env.ariStasisWaitMs || 0));
    let lastError = null;

    while (Date.now() - startedAt <= maxWait) {
        try {
            await ariRequest("post", `/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
                params: {
                    channel: channelId,
                },
            });

            if (lastError) {
                console.log("[ari] bridge addChannel succeeded after retry", {
                    channelId,
                    bridgeId,
                    waitedMs: Date.now() - startedAt,
                });
            }

            return;
        } catch (error) {
            lastError = error;

            if (!isRetryableBridgeAddChannelError(error)) {
                throw error;
            }

            console.warn("[ari] bridge addChannel waiting for Stasis", {
                channelId,
                bridgeId,
                waitedMs: Date.now() - startedAt,
                status: error?.response?.status,
                message: error?.response?.data?.message || error?.message,
            });

            if (Date.now() - startedAt >= maxWait) {
                break;
            }

            await delay(250);
        }
    }

    console.warn("[ari] bridge addChannel failed after wait", {
        channelId,
        bridgeId,
        waitedMs: Date.now() - startedAt,
        status: lastError?.response?.status,
        message: lastError?.message,
        data: lastError?.response?.data,
    });

    throw lastError;
}

function isRetryableBridgeAddChannelError(error) {
    const status = Number(error?.response?.status || error?.status || 0);
    const message = String(error?.response?.data?.message || error?.message || "").toLowerCase();

    if (status === 409 && message.includes("not in stasis")) {
        return true;
    }

    if (status !== 422) {
        return false;
    }

    return message === "" ||
        message.includes("stasis") ||
        message.includes("addchannel") ||
        message.includes("add channel") ||
        message.includes("channel");
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function findSessionByLinkedId(linkedid) {
    const target = String(linkedid || "").trim();

    if (!target) {
        return null;
    }

    const sessions = Array.from(sessionsByChannelId.values())
        .filter((session) => session.linkedid === target || session.channelId === target)
        .sort((left, right) => {
            if (left.status === "ended" && right.status !== "ended") {
                return 1;
            }

            if (left.status !== "ended" && right.status === "ended") {
                return -1;
            }

            return new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt);
        });

    return sessions[0] || null;
}

function ensureReady() {
    if (!env.ariEnabled) {
        const error = new Error("ARI is disabled");
        error.status = 409;
        throw error;
    }

    if (!env.ariUsername || !env.ariPassword) {
        const error = new Error("ARI credentials are missing");
        error.status = 503;
        throw error;
    }
}

function buildEventsUrl() {
    const explicit = env.ariWsUrl ? new URL(env.ariWsUrl) : new URL("/ari/events", wsBaseUrl());

    explicit.searchParams.set("app", env.ariAppName);
    explicit.searchParams.set("subscribeAll", "true");
    explicit.searchParams.set("api_key", `${env.ariUsername}:${env.ariPassword}`);

    return explicit.toString();
}

function restBaseUrl() {
    return `${env.ariBaseUrl.replace(/\/$/, "")}/ari`;
}

function wsBaseUrl() {
    const base = env.ariBaseUrl.replace(/\/$/, "");

    if (base.startsWith("https://")) {
        return `wss://${base.slice(8)}`;
    }

    if (base.startsWith("http://")) {
        return `ws://${base.slice(7)}`;
    }

    return base;
}

function safeBaseUrl() {
    return env.ariBaseUrl.replace(/\/$/, "");
}

function basicAuthHeader() {
    return `Basic ${Buffer.from(`${env.ariUsername}:${env.ariPassword}`).toString("base64")}`;
}

function normalizeMedia(media) {
    const value = String(media || "").trim();

    if (!value) {
        const error = new Error("media is required");
        error.status = 422;
        throw error;
    }

    return value.includes(":") ? value : `sound:${value}`;
}

module.exports = {
    start,
    stop,
    getStatus,
    getEvents,
    listSessions,
    getSession,
    getSessionByLinkedId,
    onSessionEvent,
    answerSession,
    answerCallByLinkedId,
    ensureBridge,
    ensureCallBridgeByLinkedId,
    playMedia,
    playCallMediaByLinkedId,
    hangupSession,
    hangupCallByLinkedId,
    ariRequest,
};
