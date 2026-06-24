const crypto = require("crypto");
const dgram = require("dgram");

const env = require("../../config/env");
const ariService = require("./ari.service");
const pbxService = require("../pbx/pbx.service");
const {
    parseRtpPacket,
    buildRtpPacket,
    decodeUlawPayloadToPcm48,
    pcm48BufferToUlawPayloads,
} = require("./rtp-media");

const mediaSessionsById = new Map();
const mediaSessionsByLinkedId = new Map();

ariService.onSessionEvent((session, event) => {
    if (!["StasisEnd", "ChannelDestroyed"].includes(event.type)) {
        return;
    }

    const mediaSession = mediaSessionsByLinkedId.get(session.linkedid);

    if (!mediaSession || mediaSession.channelId !== session.channelId) {
        return;
    }

    setImmediate(() => {
        closeMediaSession(mediaSession.id, "ari_channel_ended").catch((error) => {
            console.warn("[ari:media] auto close failed", {
                linkedid: mediaSession.linkedid,
                message: error.message,
            });
        });
    });
});

async function startMediaSessionByLinkedId(linkedid, options = {}) {
    ensureMediaFormatSupported();

    const targetLinkedid = String(linkedid || "").trim();

    if (!targetLinkedid) {
        const error = new Error("linkedid is required");
        error.status = 422;
        throw error;
    }

    const existing = mediaSessionsByLinkedId.get(targetLinkedid);

    if (existing && existing.status !== "closed") {
        return snapshotMediaSession(existing);
    }

    let baseSession = ariService.getSessionByLinkedId(targetLinkedid);

    if (!baseSession && env.ariStasisRedirectEnabled) {
        await redirectTrackedCallToStasis(targetLinkedid);
        baseSession = await waitForAriSession(targetLinkedid, env.ariStasisWaitMs);
    }

    if (!baseSession) {
        const error = new Error("ARI session not found for linkedid");
        error.status = 404;
        throw error;
    }

    if (!baseSession.answeredAt && !["answered", "bridged"].includes(baseSession.status)) {
        await ariService.answerCallByLinkedId(targetLinkedid);
    }

    const bridgedSession = await ariService.ensureCallBridgeByLinkedId(targetLinkedid);

    const mediaSession = createMediaSession(targetLinkedid, bridgedSession, options);
    mediaSessionsById.set(mediaSession.id, mediaSession);
    mediaSessionsByLinkedId.set(targetLinkedid, mediaSession);

    try {
        await bindRtpSocket(mediaSession);
        await createExternalMediaChannel(mediaSession);
        mediaSession.status = "ready";
        mediaSession.updatedAt = new Date().toISOString();

        return snapshotMediaSession(mediaSession);
    } catch (error) {
        console.error("[ari:media] start failed", {
            linkedid: targetLinkedid,
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
            url: error.config?.url,
            method: error.config?.method,
        });
        await closeMediaSession(mediaSession.id, "start_failed").catch(() => {});
        throw error;
    }
}

async function redirectTrackedCallToStasis(linkedid) {
    try {
        await pbxService.redirectCallToStasis(linkedid);
    } catch (error) {
        console.warn("[ari:media] redirect to Stasis failed", {
            linkedid,
            message: error.message,
        });
    }
}

async function waitForAriSession(linkedid, timeoutMs) {
    const startedAt = Date.now();
    const maxWait = Math.max(0, Number(timeoutMs || 0));

    while (Date.now() - startedAt <= maxWait) {
        const session = ariService.getSessionByLinkedId(linkedid);

        if (session) {
            return session;
        }

        await delay(150);
    }

    return null;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMediaSession(idOrLinkedid) {
    const key = String(idOrLinkedid || "").trim();
    const session = mediaSessionsById.get(key) || mediaSessionsByLinkedId.get(key);

    return session ? snapshotMediaSession(session) : null;
}

function listMediaSessions() {
    return Array.from(mediaSessionsById.values()).map(snapshotMediaSession);
}

async function closeMediaSession(idOrLinkedid, reason = "closed") {
    const key = String(idOrLinkedid || "").trim();
    const session = mediaSessionsById.get(key) || mediaSessionsByLinkedId.get(key);

    if (!session || session.status === "closed") {
        return session ? snapshotMediaSession(session) : null;
    }

    session.status = "closed";
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    session.closeReason = reason;

    if (session.agentWs && session.agentWs.readyState === 1) {
        session.agentWs.close(1000, reason);
    }

    session.agentWs = null;

    if (session.rtpSocket) {
        session.rtpSocket.removeAllListeners();
        session.rtpSocket.close();
        session.rtpSocket = null;
    }

    if (session.externalChannelId) {
        await ariService.ariRequest("delete", `/channels/${encodeURIComponent(session.externalChannelId)}`)
            .catch((error) => {
                console.warn("[ari:media] external media hangup failed", {
                    linkedid: session.linkedid,
                    externalChannelId: session.externalChannelId,
                    message: error.message,
                    status: error.response?.status,
                });
            });
    }

    mediaSessionsById.delete(session.id);
    mediaSessionsByLinkedId.delete(session.linkedid);

    return snapshotMediaSession(session);
}

function attachAgentWebSocket(linkedid, ws, options = {}) {
    const session = mediaSessionsByLinkedId.get(String(linkedid || "").trim());

    if (!session || session.status === "closed") {
        ws.close(1008, "media_session_not_found");
        return false;
    }

    if (String(options.key || "") !== session.wsKey) {
        ws.close(1008, "invalid_media_key");
        return false;
    }

    if (session.agentWs && session.agentWs.readyState === 1) {
        session.agentWs.close(1000, "agent_replaced");
    }

    session.agentWs = ws;
    session.activeAgentId = options.agentId || null;
    session.status = "agent_connected";
    session.updatedAt = new Date().toISOString();

    console.log("[ari:media] agent websocket connected", {
        linkedid: session.linkedid,
        agentId: session.activeAgentId,
    });

    ws.on("message", (message, isBinary) => {
        if (!isBinary || session.status === "closed") {
            return;
        }

        const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
        sendAgentAudioToAsterisk(session, buffer);
    });

    ws.on("close", (code, reason) => {
        if (session.agentWs === ws) {
            session.agentWs = null;
        }

        session.updatedAt = new Date().toISOString();

        console.log("[ari:media] agent websocket closed", {
            linkedid: session.linkedid,
            code,
            reason: reason ? reason.toString() : "",
        });
    });

    ws.on("error", (error) => {
        session.lastError = error.message;
        console.warn("[ari:media] agent websocket error", {
            linkedid: session.linkedid,
            message: error.message,
        });
    });

    return true;
}

function createMediaSession(linkedid, ariSession, options = {}) {
    const id = crypto.randomUUID();
    const wsKey = crypto.randomBytes(24).toString("hex");
    const path = `/api/ari/calls/${encodeURIComponent(linkedid)}/agent-ws?key=${encodeURIComponent(wsKey)}${options.agentId ? `&agent_id=${encodeURIComponent(options.agentId)}` : ""}`;
    const now = new Date().toISOString();

    return {
        id,
        linkedid,
        channelId: ariSession.channelId,
        bridgeId: ariSession.bridgeId,
        status: "starting",
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        closeReason: null,
        externalChannelId: null,
        rtpSocket: null,
        rtpHost: env.ariExternalMediaHost,
        rtpBindHost: env.ariExternalMediaBindHost,
        rtpPort: null,
        remoteRtp: null,
        rtpPacketsReceived: 0,
        rtpPacketsSent: 0,
        agentFramesReceived: 0,
        browserFramesSent: 0,
        wsKey,
        agentWebSocketPath: path,
        agentWebSocketUrl: publicWebSocketUrl(path),
        agentWs: null,
        activeAgentId: options.agentId || null,
        lastError: null,
        codecState: {
            downsampleRemainder: new Int16Array(0),
            ulawRemainder: Buffer.alloc(0),
        },
        rtpSendState: {
            sequence: crypto.randomInt(0, 0xffff),
            timestamp: crypto.randomInt(0, 0xffffffff),
            ssrc: crypto.randomInt(1, 0xffffffff),
        },
    };
}

async function bindRtpSocket(session) {
    const socket = await bindUdpPort(session);
    session.rtpSocket = socket;

    socket.on("message", (packet, rinfo) => {
        session.remoteRtp = {
            address: rinfo.address,
            port: rinfo.port,
        };

        handleRtpPacket(session, packet);
    });

    socket.on("error", (error) => {
        session.lastError = error.message;
        console.error("[ari:media] rtp socket error", {
            linkedid: session.linkedid,
            port: session.rtpPort,
            message: error.message,
        });
    });
}

function bindUdpPort(session) {
    const start = env.ariExternalMediaPortStart;
    const end = Math.max(start, env.ariExternalMediaPortEnd);

    return new Promise((resolve, reject) => {
        let current = start;

        const tryBind = () => {
            if (current > end) {
                const error = new Error(`No free RTP port found in ${start}-${end}`);
                error.status = 503;
                reject(error);
                return;
            }

            const socket = dgram.createSocket("udp4");
            const port = current;
            current += 1;

            const fail = (error) => {
                socket.removeAllListeners();
                try {
                    socket.close();
                } catch (_) {
                    // Socket may fail before bind completes.
                }

                if (error.code === "EADDRINUSE") {
                    tryBind();
                    return;
                }

                reject(error);
            };

            socket.once("error", fail);
            socket.bind(port, env.ariExternalMediaBindHost, () => {
                socket.removeListener("error", fail);
                session.rtpPort = port;
                resolve(socket);
            });
        };

        tryBind();
    });
}

async function createExternalMediaChannel(session) {
    const response = await ariService.ariRequest("post", "/channels/externalMedia", {
        params: {
            app: env.ariAppName,
            external_host: `${session.rtpHost}:${session.rtpPort}`,
            format: env.ariExternalMediaFormat,
            encapsulation: "rtp",
            transport: "udp",
            connection_type: "client",
            direction: "both",
        },
    });

    session.externalChannelId = response.data?.id || response.data?.channel?.id || null;

    if (!session.externalChannelId) {
        const error = new Error("ARI external media channel was not created");
        error.status = 502;
        throw error;
    }

    await ariService.ariRequest("post", `/bridges/${encodeURIComponent(session.bridgeId)}/addChannel`, {
        params: {
            channel: session.externalChannelId,
        },
    });

    console.log("[ari:media] external media ready", {
        linkedid: session.linkedid,
        bridgeId: session.bridgeId,
        externalChannelId: session.externalChannelId,
        externalHost: `${session.rtpHost}:${session.rtpPort}`,
        format: env.ariExternalMediaFormat,
    });
}

function handleRtpPacket(session, packet) {
    const rtp = parseRtpPacket(packet);

    if (!rtp || !rtp.payload.length) {
        return;
    }

    session.rtpPacketsReceived += 1;
    session.updatedAt = new Date().toISOString();

    if (!session.agentWs || session.agentWs.readyState !== 1) {
        return;
    }

    try {
        session.agentWs.send(decodeUlawPayloadToPcm48(rtp.payload), { binary: true });
        session.browserFramesSent += 1;
    } catch (error) {
        session.lastError = error.message;
    }
}

function sendAgentAudioToAsterisk(session, pcm48Buffer) {
    if (!session.rtpSocket || !session.remoteRtp) {
        return;
    }

    const frameSamples = Math.max(1, Math.round(8000 * env.ariExternalMediaFrameMs / 1000));
    const payloads = pcm48BufferToUlawPayloads(pcm48Buffer, session.codecState, frameSamples);

    for (const payload of payloads) {
        const packet = buildRtpPacket(payload, session.rtpSendState, {
            payloadType: env.ariExternalMediaPayloadType,
        });

        session.rtpSocket.send(packet, session.remoteRtp.port, session.remoteRtp.address);
        session.rtpPacketsSent += 1;
    }

    if (payloads.length > 0) {
        session.agentFramesReceived += 1;
        session.updatedAt = new Date().toISOString();
    }
}

function snapshotMediaSession(session) {
    return {
        id: session.id,
        linkedid: session.linkedid,
        channelId: session.channelId,
        bridgeId: session.bridgeId,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        closedAt: session.closedAt,
        closeReason: session.closeReason,
        externalChannelId: session.externalChannelId,
        rtpHost: session.rtpHost,
        rtpBindHost: session.rtpBindHost,
        rtpPort: session.rtpPort,
        remoteRtp: session.remoteRtp ? { ...session.remoteRtp } : null,
        rtpPacketsReceived: session.rtpPacketsReceived,
        rtpPacketsSent: session.rtpPacketsSent,
        agentFramesReceived: session.agentFramesReceived,
        browserFramesSent: session.browserFramesSent,
        activeAgentId: session.activeAgentId,
        agentWebSocketUrl: session.agentWebSocketUrl,
        agentWebSocketPath: session.agentWebSocketPath,
        hasAgentWebSocket: Boolean(session.agentWs && session.agentWs.readyState === 1),
        format: env.ariExternalMediaFormat,
        lastError: session.lastError,
    };
}

function publicWebSocketUrl(path) {
    const base = String(env.publicBaseUrl || "").trim().replace(/\/$/, "");

    if (!base) {
        return path;
    }

    if (base.startsWith("https://")) {
        return `wss://${base.slice(8)}${path}`;
    }

    if (base.startsWith("http://")) {
        return `ws://${base.slice(7)}${path}`;
    }

    if (base.startsWith("ws://") || base.startsWith("wss://")) {
        return `${base}${path}`;
    }

    return `${base}${path}`;
}

function ensureMediaFormatSupported() {
    if (String(env.ariExternalMediaFormat || "").toLowerCase() !== "ulaw") {
        const error = new Error("The browser media bridge currently supports ARI_EXTERNAL_MEDIA_FORMAT=ulaw only");
        error.status = 422;
        throw error;
    }
}

module.exports = {
    startMediaSessionByLinkedId,
    getMediaSession,
    listMediaSessions,
    closeMediaSession,
    attachAgentWebSocket,
};
