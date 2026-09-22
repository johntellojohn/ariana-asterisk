const crypto = require("crypto");
const dgram = require("dgram");

const env = require("../../config/env");
const ariService = require("./ari.service");
const disconnectToneDetector = require("./disconnect-tone-detector");
const pbxService = require("../pbx/pbx.service");
const laravelService = require("../laravel/laravel.service");
const { CallRecording } = require("../calls/call-recording");
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

    const mediaSession = (session.linkedid && mediaSessionsByLinkedId.get(session.linkedid)) ||
        (session.channelId && mediaSessionsById.get(session.channelId));

    if (!mediaSession || mediaSession.status === "closed") {
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

if (typeof pbxService.onRedirectStasisEarlyEnd === "function") {
    pbxService.onRedirectStasisEarlyEnd((event) => {
        if (!event || !event.linkedid) {
            return;
        }

        const mediaSession = mediaSessionsByLinkedId.get(event.linkedid);
        if (mediaSession && mediaSession.status !== "closed") {
            setImmediate(() => {
                closeMediaSession(mediaSession.id, "redirect_stasis_early_end").catch((error) => {
                    console.warn("[ari:media] early end auto close failed", {
                        linkedid: mediaSession.linkedid,
                        message: error.message,
                    });
                });
            });
        }
    });
}

if (typeof pbxService.onManagerEvent === "function") {
    pbxService.onManagerEvent((event) => {
        if (!event || !event.linkedid) {
            return;
        }

        const eventName = String(event.event || "").toLowerCase();

        if (["hangup", "bridgeleave"].includes(eventName)) {
            const mediaSession = mediaSessionsByLinkedId.get(event.linkedid);

            if (mediaSession && mediaSession.status !== "closed") {
                setImmediate(() => {
                    closeMediaSession(mediaSession.id, `pbx_${eventName}`).catch((error) => {
                        console.warn("[ari:media] pbx event auto close failed", {
                            linkedid: mediaSession.linkedid,
                            message: error.message,
                        });
                    });
                });
            }
        }
    });
}

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
        existing.tenant = options.tenant || existing.tenant || null;
        existing.callbackUrl = options.callbackUrl || options.callback_url || existing.callbackUrl || null;

        if (
            options.owner &&
            existing.owner &&
            existing.owner !== options.owner
        ) {
            const error = new Error(`ARI media session already owned by ${existing.owner}`);
            error.status = 409;
            throw error;
        }

        if (
            options.owner === "agent" &&
            options.agentId &&
            !(existing.agentWs && existing.agentWs.readyState === 1) &&
            String(existing.activeAgentId || "") !== String(options.agentId)
        ) {
            refreshAgentWebSocketAccess(existing, options.agentId);
        }

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

        await delay(35);
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

    if (session.rtpSendTimer) {
        clearTimeout(session.rtpSendTimer);
        session.rtpSendTimer = null;
    }

    session.rtpNextSendAt = 0;
    session.rtpSendQueue = [];

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

    if (session.recording) {
        const recording = session.recording;
        session.recording = null;

        await recording.finalize(reason).catch((error) => {
            console.warn("[ari:media] recording finalize failed", {
                linkedid: session.linkedid,
                message: error.message,
            });
        });
    }

    if (mediaSessionsById.get(session.id) === session) {
        mediaSessionsById.delete(session.id);
    }

    if (mediaSessionsByLinkedId.get(session.linkedid) === session) {
        mediaSessionsByLinkedId.delete(session.linkedid);
    }

    if (typeof session.onClose === "function") {
        try {
            session.onClose(snapshotMediaSession(session));
        } catch (error) {
            console.warn("[ari:media] close callback failed", {
                linkedid: session.linkedid,
                message: error.message,
            });
        }
    }

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
    session.disconnectToneArmed = false;
    session.disconnectToneClosed = false;
    disconnectToneDetector.reset(session);

    if (session.recording) {
        session.recording.agentId = session.activeAgentId;
    }

    console.log("[ari:media] agent websocket connected", {
        linkedid: session.linkedid,
        agentId: session.activeAgentId,
    });

    ws.on("message", (message, isBinary) => {
        if (!isBinary || session.status === "closed" || session.agentWs !== ws) {
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

function activateAgentOwner(idOrLinkedid, options = {}) {
    const key = String(idOrLinkedid || "").trim();
    const session = mediaSessionsById.get(key) || mediaSessionsByLinkedId.get(key);
    const transferId = String(options.transferId || options.transfer_id || "").trim() || null;
    const humanAgentId = options.agentId || options.agent_id || null;

    if (!session || session.status === "closed") {
        const error = new Error("ARI media session not found");
        error.status = 404;
        throw error;
    }

    if (session.owner === "agent") {
        if (
            humanAgentId &&
            !(session.agentWs && session.agentWs.readyState === 1) &&
            String(session.activeAgentId || "") !== String(humanAgentId)
        ) {
            refreshAgentWebSocketAccess(session, humanAgentId);
        }

        return snapshotMediaSession(session);
    }

    if (session.owner !== "ai") {
        const error = new Error(`ARI media session is not owned by AI (${session.owner || "unknown"})`);
        error.status = 409;
        throw error;
    }

    const aiAgentId = session.aiAgentId;

    clearAsteriskAudioQueue(session.id, "ai_to_human_transfer");
    session.owner = "agent";
    session.activeAgentId = humanAgentId;
    session.aiAgentId = null;
    session.lastTransferId = transferId;
    session.onAsteriskPcm48 = null;
    session.onClose = null;
    session.status = "agent_waiting";
    session.updatedAt = new Date().toISOString();
    session.disconnectToneArmed = false;
    session.disconnectToneClosed = false;
    disconnectToneDetector.reset(session);
    refreshAgentWebSocketAccess(session, humanAgentId);

    if (session.recording) {
        session.recording.addParticipantTransition({
            transfer_id: transferId,
            from_type: "ai",
            from_id: aiAgentId,
            to_type: "human",
            to_id: humanAgentId,
        });
        session.recording.agentId = humanAgentId;
    }

    console.log("[ari:media] media owner transferred from AI to human", {
        linkedid: session.linkedid,
        transferId,
        fromAiAgentId: aiAgentId,
        humanAgentId,
        mediaSessionId: session.id,
    });

    return snapshotMediaSession(session);
}

function activateAiOwner(idOrLinkedid, options = {}) {
    const key = String(idOrLinkedid || "").trim();
    const session = mediaSessionsById.get(key) || mediaSessionsByLinkedId.get(key);
    const transferId = String(options.transferId || options.transfer_id || "").trim();

    if (!transferId) {
        const error = new Error("transfer_id is required");
        error.status = 422;
        throw error;
    }

    if (!session || session.status === "closed") {
        const error = new Error("ARI media session not found");
        error.status = 404;
        throw error;
    }

    if (session.owner === "ai" && session.lastTransferId === transferId) {
        return snapshotMediaSession(session);
    }

    if (session.owner !== "agent") {
        const error = new Error(`ARI media session is not owned by a human agent (${session.owner || "unknown"})`);
        error.status = 409;
        throw error;
    }

    const humanWs = session.agentWs;
    const humanAgentId = session.activeAgentId;

    if (!humanWs || humanWs.readyState !== 1) {
        const error = new Error("Human agent WebSocket is not connected");
        error.status = 409;
        throw error;
    }

    clearAsteriskAudioQueue(session.id, "human_to_ai_transfer");
    session.owner = "ai";
    session.aiAgentId = options.agentId || options.agent_id || null;
    session.lastTransferId = transferId;
    session.onAsteriskPcm48 = typeof options.onAsteriskPcm48 === "function"
        ? options.onAsteriskPcm48
        : null;
    session.onClose = typeof options.onClose === "function"
        ? options.onClose
        : null;
    session.disconnectToneArmed = false;
    session.disconnectToneClosed = false;
    disconnectToneDetector.reset(session);
    session.agentWs = null;
    session.activeAgentId = null;
    session.status = "ai_connected";
    session.updatedAt = new Date().toISOString();

    if (session.recording) {
        session.recording.addParticipantTransition({
            transfer_id: transferId,
            from_type: "human",
            from_id: humanAgentId,
            to_type: "ai",
            to_id: session.aiAgentId,
        });
        session.recording.agentId = session.aiAgentId;
    }

    humanWs.close(1000, "transferred_to_ai");

    console.log("[ari:media] media owner transferred from human to AI", {
        linkedid: session.linkedid,
        transferId,
        fromAgentId: humanAgentId,
        aiAgentId: session.aiAgentId,
    });

    return snapshotMediaSession(session);
}

function createMediaSession(linkedid, ariSession, options = {}) {
    const id = crypto.randomUUID();
    const startsWithAi = options.owner === "ai";
    const agentAccess = createAgentWebSocketAccess(
        linkedid,
        startsWithAi ? null : options.agentId
    );
    const now = new Date().toISOString();

    return {
        id,
        linkedid,
        owner: options.owner || "agent",
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
        remoteRtpSource: null,
        rtpPacketsReceived: 0,
        rtpPacketsSent: 0,
        rtpPacketsDroppedLatency: 0,
        agentFramesReceived: 0,
        agentFramesDroppedNoRtp: 0,
        browserFramesSent: 0,
        tenant: options.tenant || null,
        callbackUrl: options.callbackUrl || options.callback_url || null,
        disconnectToneArmed: false,
        disconnectToneClosed: false,
        disconnectToneMs: 0,
        disconnectToneLastAt: 0,
        disconnectToneBurstMs: 0,
        disconnectToneGapMs: 0,
        disconnectToneLastGapMs: 0,
        disconnectToneBursts: 0,
        disconnectToneCadenceStartedAt: 0,
        disconnectToneBurstFrequency: null,
        disconnectToneReferenceFrequency: null,
        disconnectToneBurstQualified: false,
        wsKey: agentAccess.key,
        agentWebSocketPath: agentAccess.path,
        agentWebSocketUrl: agentAccess.url,
        agentWs: null,
        activeAgentId: startsWithAi ? null : options.agentId || null,
        aiAgentId: startsWithAi ? options.agentId || null : null,
        lastTransferId: null,
        lastError: null,
        onAsteriskPcm48: typeof options.onAsteriskPcm48 === "function"
            ? options.onAsteriskPcm48
            : null,
        onClose: typeof options.onClose === "function"
            ? options.onClose
            : null,
        codecState: {
            downsampleRemainder: new Int16Array(0),
            ulawRemainder: Buffer.alloc(0),
        },
        rtpSendState: {
            sequence: crypto.randomInt(0, 0xffff),
            timestamp: crypto.randomInt(0, 0xffffffff),
            ssrc: crypto.randomInt(1, 0xffffffff),
        },
        rtpSendQueue: [],
        rtpSendTimer: null,
        rtpNextSendAt: 0,
        recording: new CallRecording({
            sessionId: id,
            callId: linkedid,
            linkedid,
            tenant: options.tenant || null,
            agentId: options.agentId || null,
            mode: options.owner === "ai" ? "trunk_ai" : "trunk_human",
            logger: (message, data) => {
                console.warn(`[ari:media] ${message}`, {
                    linkedid,
                    ...data,
                });
            },
        }),
    };
}

async function bindRtpSocket(session) {
    const socket = await bindUdpPort(session);
    session.rtpSocket = socket;

    socket.on("message", (packet, rinfo) => {
        const firstPacket = session.rtpPacketsReceived === 0;
        session.remoteRtp = {
            address: rinfo.address,
            port: rinfo.port,
        };
        session.remoteRtpSource = "inbound_packet";

        if (firstPacket) {
            console.log("[ari:media] first RTP packet received from Asterisk", {
                linkedid: session.linkedid,
                address: rinfo.address,
                port: rinfo.port,
            });
        }

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

    await resolveAsteriskRtpDestination(session).catch((error) => {
        session.lastError = error.message;
        console.warn("[ari:media] Asterisk RTP destination not available; waiting for inbound RTP", {
            linkedid: session.linkedid,
            externalChannelId: session.externalChannelId,
            message: error.message,
        });
    });

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
        asteriskRtpDestination: session.remoteRtp,
        format: env.ariExternalMediaFormat,
    });
}

async function resolveAsteriskRtpDestination(session, request = ariService.ariRequest) {
    const channelId = encodeURIComponent(session.externalChannelId);
    let lastError = null;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
            const [addressResponse, portResponse] = await Promise.all([
                request("get", `/channels/${channelId}/variable`, {
                    params: { variable: "UNICASTRTP_LOCAL_ADDRESS" },
                }),
                request("get", `/channels/${channelId}/variable`, {
                    params: { variable: "UNICASTRTP_LOCAL_PORT" },
                }),
            ]);
            const address = String(addressResponse.data?.value || "").trim();
            const port = Number(portResponse.data?.value || 0);

            if (address && Number.isInteger(port) && port > 0 && port <= 65535) {
                session.remoteRtp = { address, port };
                session.remoteRtpSource = "channel_variables";
                session.lastError = null;
                session.updatedAt = new Date().toISOString();

                console.log("[ari:media] Asterisk RTP destination resolved", {
                    linkedid: session.linkedid,
                    address,
                    port,
                    attempt,
                });

                return session.remoteRtp;
            }

            lastError = new Error("Asterisk returned an invalid UnicastRTP address or port");
        } catch (error) {
            lastError = error;
        }

        if (attempt < 5) {
            await delay(15 * attempt);
        }
    }

    throw new Error(`Unable to resolve Asterisk RTP destination: ${lastError?.message || "unknown error"}`);
}

function handleRtpPacket(session, packet) {
    const rtp = parseRtpPacket(packet);

    if (!rtp || !rtp.payload.length) {
        return;
    }

    session.rtpPacketsReceived += 1;
    session.updatedAt = new Date().toISOString();

    const pcm48 = decodeUlawPayloadToPcm48(rtp.payload);

    if (trackHumanDisconnectTone(session, pcm48)) {
        return;
    }

    if (session.recording) {
        session.recording.recordCustomerPcm(pcm48, {
            sampleRate: 48000,
            channelCount: 1,
        });
    }

    if (typeof session.onAsteriskPcm48 === "function") {
        try {
            session.onAsteriskPcm48(pcm48, {
                linkedid: session.linkedid,
                packet: rtp,
            });
        } catch (error) {
            session.lastError = error.message;
            console.warn("[ari:media] RTP audio callback failed", {
                linkedid: session.linkedid,
                message: error.message,
            });
        }
    }

    if (!session.agentWs || session.agentWs.readyState !== 1) {
        return;
    }

    try {
        session.agentWs.send(pcm48, { binary: true });
        session.browserFramesSent += 1;
    } catch (error) {
        session.lastError = error.message;
    }
}

function trackHumanDisconnectTone(session, pcm48) {
    if (!env.trunkHumanDisconnectToneEnabled
        || session.owner !== "agent"
        || session.status === "closed"
        || !session.disconnectToneArmed
        || !session.agentWs
        || session.agentWs.readyState !== 1) {
        return false;
    }

    const previousBursts = session.disconnectToneBursts || 0;
    const frame = disconnectToneDetector.createFrame(pcm48);
    const result = disconnectToneDetector.track(session, pcm48, frame, {
        enabled: true,
        hasOutput: true,
    });

    if (!result.shouldClose && (session.disconnectToneBursts || 0) > previousBursts) {
        console.log("[ari:media] disconnect tone cadence candidate", {
            linkedid: session.linkedid,
            bursts: session.disconnectToneBursts,
            burstMs: Math.round(session.disconnectToneBurstMs || 0),
            frequency: session.disconnectToneReferenceFrequency,
        });
    }

    if (!result.shouldClose) {
        return false;
    }

    closeAfterHumanDisconnectTone(session, result.reason);

    return true;
}

function closeAfterHumanDisconnectTone(session, detail = {}) {
    if (session.disconnectToneClosed || session.status === "closed") {
        return;
    }

    session.disconnectToneClosed = true;

    console.log("[ari:media] disconnect tone detected, closing human trunk session", {
        linkedid: session.linkedid,
        sessionId: session.id,
        ...detail,
    });

    notifyHumanDisconnectToneEnded(session, detail).catch((error) => {
        console.warn("[ari:media] failed notifying Laravel after disconnect tone", {
            linkedid: session.linkedid,
            sessionId: session.id,
            message: error.message,
            status: error.status || error.response?.status || null,
        });
    });

    pbxService.hangupCall(session.linkedid, "disconnect_tone_detected").catch((error) => {
        session.lastError = error.message;
        console.warn("[ari:media] failed hanging up PBX call after disconnect tone", {
            linkedid: session.linkedid,
            sessionId: session.id,
            message: error.message,
            status: error.status || error.response?.status || null,
        });
    });
}

async function notifyHumanDisconnectToneEnded(session, detail = {}) {
    if (!session.callbackUrl) {
        return;
    }

    const time = new Date().toISOString();

    await laravelService.sendTrunkCallEvent({
        tenant: session.tenant || undefined,
        source: "ariana-asterisk-human-disconnect-tone",
        event: {
            time,
            event: "ended",
            linkedid: session.linkedid,
            dialStatus: "HANGUP",
            causeTxt: "disconnect_tone_detected",
            reason: "disconnect_tone_detected",
            disconnect_tone: detail,
        },
        summary: {
            linkedid: session.linkedid,
            lastEventTime: time,
            status: "HANGUP",
            answered: true,
            bridged: false,
            result: "hangup",
        },
    });
}

function sendAgentAudioToAsterisk(session, pcm48Buffer) {
    session.agentFramesReceived += 1;
    session.updatedAt = new Date().toISOString();

    if (session.owner === "agent") {
        session.disconnectToneArmed = true;
    }

    if (session.agentFramesReceived === 1) {
        console.log("[ari:media] first browser audio frame received", {
            linkedid: session.linkedid,
            bytes: pcm48Buffer.length,
            hasRtpDestination: Boolean(session.remoteRtp),
        });
    }

    if (session.recording) {
        session.recording.recordAgentPcm(pcm48Buffer, {
            sampleRate: 48000,
            channelCount: 1,
        });
    }

    if (!session.rtpSocket || !session.remoteRtp) {
        session.agentFramesDroppedNoRtp += 1;
        return;
    }

    const frameSamples = Math.max(1, Math.round(8000 * env.ariExternalMediaFrameMs / 1000));
    const payloads = pcm48BufferToUlawPayloads(pcm48Buffer, session.codecState, frameSamples);

    if (payloads.length > 0) {
        enqueueRtpPayloads(session, payloads);
        startRtpSendTimer(session);
    }
}

function enqueueRtpPayloads(session, payloads) {
    session.rtpSendQueue.push(...payloads);

    const frameMs = Math.max(1, env.ariExternalMediaFrameMs);
    const maxQueueFrames = Math.max(1, Math.ceil(env.ariExternalMediaMaxQueueMs / frameMs));
    const excess = Math.max(0, session.rtpSendQueue.length - maxQueueFrames);

    if (excess === 0) {
        return 0;
    }

    session.rtpSendQueue.splice(0, excess);
    session.rtpPacketsDroppedLatency = (session.rtpPacketsDroppedLatency || 0) + excess;

    if (session.rtpPacketsDroppedLatency === excess || session.rtpPacketsDroppedLatency % 50 < excess) {
        console.warn("[ari:media] stale RTP audio dropped to preserve realtime", {
            linkedid: session.linkedid,
            dropped: excess,
            droppedTotal: session.rtpPacketsDroppedLatency,
            queueLength: session.rtpSendQueue.length,
            maxQueueMs: env.ariExternalMediaMaxQueueMs,
        });
    }

    return excess;
}

function startRtpSendTimer(session) {
    if (session.rtpSendTimer) {
        return;
    }

    const intervalMs = Math.max(1, env.ariExternalMediaFrameMs);
    session.rtpNextSendAt = Date.now();

    const sendNext = () => {
        session.rtpSendTimer = null;

        if (session.status === "closed" || !session.rtpSocket || !session.remoteRtp) {
            session.rtpNextSendAt = 0;
            return;
        }

        const payload = session.rtpSendQueue.shift();

        if (!payload) {
            session.rtpNextSendAt = 0;
            return;
        }

        const packet = buildRtpPacket(payload, session.rtpSendState, {
            payloadType: env.ariExternalMediaPayloadType,
        });

        session.rtpSocket.send(packet, session.remoteRtp.port, session.remoteRtp.address);
        session.rtpPacketsSent += 1;
        session.updatedAt = new Date().toISOString();

        if (session.rtpPacketsSent === 1) {
            console.log("[ari:media] first RTP packet sent to Asterisk", {
                linkedid: session.linkedid,
                address: session.remoteRtp.address,
                port: session.remoteRtp.port,
                source: session.remoteRtpSource,
            });
        }

        const now = Date.now();
        session.rtpNextSendAt += intervalMs;

        if (session.rtpNextSendAt < now - intervalMs) {
            session.rtpNextSendAt = now;
        }

        const delayMs = Math.max(0, session.rtpNextSendAt - now);
        session.rtpSendTimer = setTimeout(sendNext, delayMs);

        if (typeof session.rtpSendTimer.unref === "function") {
            session.rtpSendTimer.unref();
        }
    };

    sendNext();
}

function snapshotMediaSession(session) {
    return {
        id: session.id,
        linkedid: session.linkedid,
        owner: session.owner,
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
        remoteRtpSource: session.remoteRtpSource || null,
        rtpPacketsReceived: session.rtpPacketsReceived,
        rtpPacketsSent: session.rtpPacketsSent,
        rtpPacketsDroppedLatency: session.rtpPacketsDroppedLatency || 0,
        rtpSendQueueLength: session.rtpSendQueue ? session.rtpSendQueue.length : 0,
        rtpSendQueueMs: (session.rtpSendQueue ? session.rtpSendQueue.length : 0)
            * Math.max(1, env.ariExternalMediaFrameMs),
        agentFramesReceived: session.agentFramesReceived,
        agentFramesDroppedNoRtp: session.agentFramesDroppedNoRtp || 0,
        browserFramesSent: session.browserFramesSent,
        disconnectToneArmed: Boolean(session.disconnectToneArmed),
        disconnectToneBursts: session.disconnectToneBursts || 0,
        disconnectToneMs: Math.round(session.disconnectToneMs || 0),
        activeAgentId: session.activeAgentId,
        aiAgentId: session.aiAgentId || null,
        lastTransferId: session.lastTransferId || null,
        agentWebSocketUrl: session.agentWebSocketUrl,
        agentWebSocketPath: session.agentWebSocketPath,
        hasAgentWebSocket: Boolean(session.agentWs && session.agentWs.readyState === 1),
        format: env.ariExternalMediaFormat,
        lastError: session.lastError,
    };
}

function sendPcm48ToAsterisk(idOrLinkedid, pcm48Buffer) {
    const key = String(idOrLinkedid || "").trim();
    const session = mediaSessionsById.get(key) || mediaSessionsByLinkedId.get(key);

    if (!session || session.status === "closed") {
        return false;
    }

    sendAgentAudioToAsterisk(session, pcm48Buffer);

    return true;
}

function clearAsteriskAudioQueue(idOrLinkedid, reason = "cleared") {
    const key = String(idOrLinkedid || "").trim();
    const session = mediaSessionsById.get(key) || mediaSessionsByLinkedId.get(key);

    if (!session || session.status === "closed") {
        return 0;
    }

    const cleared = session.rtpSendQueue ? session.rtpSendQueue.length : 0;

    if (session.rtpSendTimer) {
        clearTimeout(session.rtpSendTimer);
        session.rtpSendTimer = null;
    }

    session.rtpNextSendAt = 0;
    session.rtpSendQueue = [];
    session.codecState = {
        downsampleRemainder: new Int16Array(0),
        ulawRemainder: Buffer.alloc(0),
    };
    session.updatedAt = new Date().toISOString();

    if (cleared > 0) {
        console.log("[ari:media] RTP output queue cleared", {
            linkedid: session.linkedid,
            reason,
            cleared,
        });
    }

    return cleared;
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

function createAgentWebSocketAccess(linkedid, agentId = null) {
    const key = crypto.randomBytes(24).toString("hex");
    const path = `/api/ari/calls/${encodeURIComponent(linkedid)}/agent-ws?key=${encodeURIComponent(key)}${agentId ? `&agent_id=${encodeURIComponent(agentId)}` : ""}`;

    return {
        key,
        path,
        url: publicWebSocketUrl(path),
    };
}

function refreshAgentWebSocketAccess(session, agentId = null) {
    const access = createAgentWebSocketAccess(session.linkedid, agentId);

    session.wsKey = access.key;
    session.agentWebSocketPath = access.path;
    session.agentWebSocketUrl = access.url;
    session.activeAgentId = agentId || null;
    session.updatedAt = new Date().toISOString();
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
    activateAgentOwner,
    activateAiOwner,
    sendPcm48ToAsterisk,
    clearAsteriskAudioQueue,
    __test: {
        registerMediaSession(session) {
            mediaSessionsById.set(session.id, session);
            mediaSessionsByLinkedId.set(session.linkedid, session);
        },
        resetMediaSessions() {
            mediaSessionsById.clear();
            mediaSessionsByLinkedId.clear();
        },
        resolveAsteriskRtpDestination,
        enqueueRtpPayloads,
        trackHumanDisconnectTone,
        closeAfterHumanDisconnectTone,
        notifyHumanDisconnectToneEnded,
    },
};
