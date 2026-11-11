const crypto = require("crypto");
const dgram = require("dgram");

const env = require("../../config/env");
const ariService = require("../ari/ari.service");
const disconnectToneDetector = require("../ari/disconnect-tone-detector");
const pbxService = require("../pbx/pbx.service");
const laravelService = require("../laravel/laravel.service");
const { CallRecording } = require("../calls/call-recording");
const {
    parseRtpPacket,
    buildRtpPacket,
    decodeUlawPayloadToPcm48,
    pcm48BufferToUlawPayloads,
} = require("../ari/rtp-media");

const mobileSessionsById = new Map();
const mobileSessionsByLinkedId = new Map();

ariService.onSessionEvent((session, event) => {
    if (!["StasisEnd", "ChannelDestroyed"].includes(event.type)) {
        return;
    }

    const mediaSession =
        (session.linkedid && mobileSessionsByLinkedId.get(session.linkedid)) ||
        (session.channelId && mobileSessionsByLinkedId.get(session.channelId)) ||
        (session.channelId && mobileSessionsById.get(session.channelId));

    if (!mediaSession || mediaSession.status === "closed") {
        return;
    }

    const eventChannelId = String(event.channel?.id || session.channelId || "");
    if (
        eventChannelId &&
        mediaSession.externalChannelId &&
        eventChannelId === String(mediaSession.externalChannelId)
    ) {
        return;
    }
    if (eventChannelId && mediaSession.channelId && eventChannelId !== String(mediaSession.channelId)) {
        return;
    }

    setImmediate(() => {
        closeMediaSession(mediaSession.id, "ari_channel_ended").catch((error) => {
            console.warn("[mobile:media] auto close failed", {
                linkedid: mediaSession.linkedid,
                message: error.message,
            });
        });
    });
});

if (typeof pbxService.onManagerEvent === "function") {
    pbxService.onManagerEvent((event) => {
        if (!event || !event.linkedid) {
            return;
        }

        const eventName = String(event.event || "").toLowerCase();

        if (["hangup", "bridgeleave"].includes(eventName)) {
            const mediaSession = mobileSessionsByLinkedId.get(String(event.linkedid));

            if (mediaSession && mediaSession.status !== "closed") {
                const channel = String(event.channel || "");
                if (
                    channel.startsWith("UnicastRTP/") ||
                    (mediaSession.externalChannelId && channel === String(mediaSession.externalChannelId))
                ) {
                    return;
                }
                if (eventName === "bridgeleave") {
                    if (["pending", "agent_waiting"].includes(mediaSession.status)) {
                        return;
                    }
                    if (mediaSession.channelId && channel && channel !== String(mediaSession.channelId)) {
                        return;
                    }
                }

                setImmediate(() => {
                    closeMediaSession(mediaSession.id, `pbx_${eventName}`).catch((error) => {
                        console.warn("[mobile:media] pbx event auto close failed", {
                            linkedid: mediaSession.linkedid,
                            message: error.message,
                        });
                    });
                });
            }
        }
    });
}

function registerPendingMediaSession(linkedid, options = {}) {
    const targetLinkedid = String(linkedid || "").trim();
    if (!targetLinkedid) {
        const error = new Error("linkedid is required for pending mobile media session");
        error.status = 422;
        throw error;
    }

    const existing =
        mobileSessionsByLinkedId.get(targetLinkedid) || mobileSessionsById.get(targetLinkedid);
    if (existing && existing.status !== "closed") {
        return existing;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const agentId = options.agentId ? String(options.agentId) : null;
    const sessionAgentKey = agentId ? `${agentId}:mobile` : null;
    const access =
        options.wsKey && options.wsUrl
            ? { key: options.wsKey, url: options.wsUrl, path: options.wsPath || "" }
            : createAgentWebSocketAccess(targetLinkedid, agentId);

    const session = {
        id,
        linkedid: targetLinkedid,
        owner: "agent",
        clientType: "mobile",
        clientSource: "mobile",
        channelId: null,
        bridgeId: null,
        status: "pending",
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
        rtpSendState: {
            sequenceNumber: crypto.randomInt(0, 65535),
            timestamp: crypto.randomInt(0, 0xffffffff),
            ssrc: crypto.randomInt(1, 0xffffffff),
        },
        rtpSendQueue: [],
        rtpSendTimer: null,
        rtpNextSendAt: 0,
        codecState: {
            downsampleRemainder: new Int16Array(0),
            ulawRemainder: Buffer.alloc(0),
        },
        agentWs: null,
        wsKey: access.key,
        activeAgentId: agentId,
        sessionAgentKey,
        agentWebSocketPath: access.path,
        agentWebSocketUrl: access.url,
        agentFramesReceived: 0,
        agentFramesDroppedNoRtp: 0,
        browserFramesSent: 0,
        disconnectToneArmed: false,
        disconnectToneBursts: 0,
        disconnectToneMs: 0,
        disconnectToneClosed: false,
        tenant: options.tenant || null,
        callbackUrl: options.callbackUrl || options.callback_url || null,
        outboundCallId: options.outboundCallId || options.outbound_call_id || null,
        direction: options.direction || "OUTBOUND",
        lastError: null,
        linkedidAliases: new Set([targetLinkedid]),
        recording: new CallRecording({
            callId: targetLinkedid,
            linkedid: targetLinkedid,
            channelId: null,
            tenant: options.tenant || null,
            callbackUrl: options.callbackUrl || options.callback_url || null,
            agentId,
            mode: "trunk_human",
            transcriptionEnabled: options.transcribeRecording !== false,
            logger: (message, data) => {
                console.warn(`[mobile:media] ${message}`, {
                    linkedid: targetLinkedid,
                    ...data,
                });
            },
        }),
    };

    if (session.outboundCallId) {
        session.linkedidAliases.add(String(session.outboundCallId));
    }

    mobileSessionsById.set(id, session);
    for (const alias of session.linkedidAliases) {
        mobileSessionsByLinkedId.set(alias, session);
    }

    return session;
}

async function startMediaSessionByLinkedId(linkedid, options = {}) {
    ensureMediaFormatSupported();

    const targetLinkedid = String(linkedid || "").trim();
    if (!targetLinkedid) {
        const error = new Error("linkedid is required");
        error.status = 422;
        throw error;
    }

    const existing =
        mobileSessionsByLinkedId.get(targetLinkedid) || mobileSessionsById.get(targetLinkedid);

    if (existing && existing.status !== "closed" && existing.channelId && existing.externalChannelId) {
        existing.tenant = options.tenant || existing.tenant || null;
        return snapshotMediaSession(existing);
    }

    const outboundKey =
        options.outboundCallId || options.outbound_call_id || existing?.outboundCallId || null;

    let baseSession = ariService.getSessionByLinkedId(targetLinkedid);
    if (!baseSession && outboundKey) {
        baseSession = ariService.getSessionByLinkedId(outboundKey);
    }

    if (!baseSession || !baseSession.inStasis) {
        if (env.ariStasisRedirectEnabled && typeof pbxService.redirectCallToStasis === "function") {
            console.log("[mobile:media] Llamada entrante no está en Stasis. Redirigiendo canal AMI a Stasis...", {
                targetLinkedid,
            });
            await pbxService.redirectCallToStasis(targetLinkedid).catch((err) => {
                console.warn("[mobile:media] Error en redirectCallToStasis:", err.message);
            });
        }
        console.log("[mobile:media] waiting for mobile call to enter Stasis", {
            targetLinkedid,
            outboundKey,
            hasSession: Boolean(baseSession),
            inStasis: Boolean(baseSession?.inStasis),
        });
        baseSession = await waitForAriSession(targetLinkedid, env.ariStasisWaitMs, outboundKey);
    }

    if (!baseSession) {
        const error = new Error("ARI session not found for mobile linkedid: " + targetLinkedid);
        error.status = 404;
        throw error;
    }

    if (!baseSession.inStasis) {
        const error = new Error(
            `El canal móvil (${baseSession.channelId || targetLinkedid}) no ingresó a Stasis.`
        );
        error.status = 422;
        throw error;
    }

    const effectiveKey = baseSession.linkedid || baseSession.channelId || targetLinkedid;

    if (!baseSession.answeredAt && !["answered", "bridged"].includes(baseSession.status)) {
        await ariService.answerCallByLinkedId(effectiveKey);
        if (typeof ariService.stopMoh === "function") {
            await ariService.stopMoh(effectiveKey).catch(() => { });
        }
    }

    const bridgedSession = await ariService.ensureCallBridgeByLinkedId(effectiveKey);

    const mediaSession =
        existing && existing.status !== "closed"
            ? existing
            : registerPendingMediaSession(targetLinkedid, options);

    mediaSession.channelId = bridgedSession.channelId;
    mediaSession.bridgeId = bridgedSession.bridgeId;
    if (mediaSession.recording) {
        mediaSession.recording.channelId = bridgedSession.channelId;
    }

    const aliases = mediaSession.linkedidAliases || new Set([targetLinkedid]);
    aliases.add(targetLinkedid);
    if (outboundKey) aliases.add(String(outboundKey));
    if (bridgedSession?.linkedid) aliases.add(String(bridgedSession.linkedid));
    if (bridgedSession?.channelId) aliases.add(String(bridgedSession.channelId));
    if (baseSession?.linkedid) aliases.add(String(baseSession.linkedid));
    if (baseSession?.channelId) aliases.add(String(baseSession.channelId));
    if (Array.isArray(baseSession?.stasisArgs)) {
        for (const arg of baseSession.stasisArgs) {
            if (arg && typeof arg === "string") aliases.add(arg);
        }
    }

    mediaSession.linkedidAliases = aliases;
    for (const alias of aliases) {
        mobileSessionsByLinkedId.set(alias, mediaSession);
    }

    try {
        if (!mediaSession.rtpSocket) {
            await bindRtpSocket(mediaSession);
        }
        if (!mediaSession.externalChannelId) {
            await createExternalMediaChannel(mediaSession);
        }
        mediaSession.status =
            mediaSession.agentWs && mediaSession.agentWs.readyState === 1
                ? "agent_connected"
                : "ready";
        mediaSession.updatedAt = new Date().toISOString();

        return snapshotMediaSession(mediaSession);
    } catch (error) {
        console.error("[mobile:media] start failed", {
            linkedid: targetLinkedid,
            message: error.message,
            status: error.response?.status,
        });
        await closeMediaSession(mediaSession.id, "start_failed").catch(() => { });
        throw error;
    }
}

function attachAgentWebSocket(linkedid, ws, options = {}) {
    const key = String(linkedid || "").trim();
    const session = mobileSessionsByLinkedId.get(key) || mobileSessionsById.get(key);

    if (!session || session.status === "closed") {
        ws.close(1008, "mobile_media_session_not_found");
        return false;
    }

    if (String(options.key || "") !== session.wsKey) {
        ws.close(1008, "invalid_media_key");
        return false;
    }

    const agentId = options.agentId ? String(options.agentId) : session.activeAgentId;
    const sessionAgentKey = agentId ? `${agentId}:mobile` : null;

    // Aislamiento estricto: solo cierra sesiones MÓVILES previas del mismo agente (${agentId}:mobile).
    // Jamás toca el mapa de sesiones Web (ari-media.service.js).
    if (sessionAgentKey) {
        for (const [id, otherSession] of mobileSessionsById.entries()) {
            if (
                otherSession !== session &&
                otherSession.status !== "closed" &&
                otherSession.sessionAgentKey === sessionAgentKey
            ) {
                closeMediaSession(id, "mobile_agent_new_call_started").catch(() => { });
            }
        }
    }

    if (session.agentWs && session.agentWs.readyState === 1) {
        session.agentWs.close(1000, "agent_replaced");
    }

    session.agentWs = ws;
    session.activeAgentId = agentId || null;
    session.sessionAgentKey = sessionAgentKey;
    session.clientType = "mobile";
    session.status = "agent_connected";
    session.updatedAt = new Date().toISOString();
    session.disconnectToneArmed = false;
    session.disconnectToneClosed = false;
    disconnectToneDetector.reset(session);

    if (session.recording) {
        session.recording.agentId = session.activeAgentId;
    }

    console.log("[mobile:media] mobile agent websocket connected", {
        linkedid: session.linkedid,
        agentId: session.activeAgentId,
        sessionAgentKey: session.sessionAgentKey,
        clientType: "mobile",
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

        console.log("[mobile:media] mobile agent websocket closed", {
            linkedid: session.linkedid,
            agentId: session.activeAgentId,
            code,
            reason: reason ? reason.toString() : "",
        });
    });

    ws.on("error", (error) => {
        session.lastError = error.message;
        console.warn("[mobile:media] mobile agent websocket error", {
            linkedid: session.linkedid,
            message: error.message,
        });
    });

    return true;
}

async function closeMediaSession(idOrLinkedid, reason = "closed") {
    const key = String(idOrLinkedid || "").trim();
    const session = mobileSessionsById.get(key) || mobileSessionsByLinkedId.get(key);

    if (!session || session.status === "closed") {
        return session ? snapshotMediaSession(session) : null;
    }

    session.status = "closed";
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    session.closeReason = reason;

    if (session.agentWs && session.agentWs.readyState === 1) {
        try {
            session.agentWs.send(JSON.stringify({
                type: "hangup",
                event: "hangup",
                reason,
                linkedid: session.linkedid,
            }));
        } catch (_) {}
        session.agentWs.close(1000, reason);
    }
    session.agentWs = null;

    if (session.rtpSocket) {
        session.rtpSocket.removeAllListeners();
        try {
            session.rtpSocket.close();
        } catch (_) {
            // ignore close error
        }
        session.rtpSocket = null;
    }

    if (session.rtpSendTimer) {
        clearTimeout(session.rtpSendTimer);
        session.rtpSendTimer = null;
    }

    session.rtpNextSendAt = 0;
    session.rtpSendQueue = [];

    if (session.externalChannelId) {
        await ariService
            .ariRequest("delete", `/channels/${encodeURIComponent(session.externalChannelId)}`)
            .catch((error) => {
                console.warn("[mobile:media] external media hangup failed", {
                    linkedid: session.linkedid,
                    externalChannelId: session.externalChannelId,
                    message: error.message,
                });
            });
    }

    if (session.recording) {
        const recording = session.recording;
        session.recording = null;
        await recording.finalize(reason).catch((error) => {
            console.warn("[mobile:media] recording finalize failed", {
                linkedid: session.linkedid,
                message: error.message,
            });
        });
    }

    if (mobileSessionsById.get(session.id) === session) {
        mobileSessionsById.delete(session.id);
    }

    if (session.linkedidAliases && session.linkedidAliases instanceof Set) {
        for (const alias of session.linkedidAliases) {
            if (mobileSessionsByLinkedId.get(alias) === session) {
                mobileSessionsByLinkedId.delete(alias);
            }
        }
    } else if (mobileSessionsByLinkedId.get(session.linkedid) === session) {
        mobileSessionsByLinkedId.delete(session.linkedid);
    }

    return snapshotMediaSession(session);
}

function getMediaSession(idOrLinkedid) {
    const key = String(idOrLinkedid || "").trim();
    const session = mobileSessionsById.get(key) || mobileSessionsByLinkedId.get(key);
    return session ? snapshotMediaSession(session) : null;
}

function hasSession(idOrLinkedid) {
    const key = String(idOrLinkedid || "").trim();
    const session = mobileSessionsById.get(key) || mobileSessionsByLinkedId.get(key);
    return Boolean(session && session.status !== "closed");
}

async function stopMediaSessionByLinkedId(idOrLinkedid, reason = "closed") {
    return closeMediaSession(idOrLinkedid, reason);
}

function listMediaSessions() {
    return Array.from(mobileSessionsById.values()).map(snapshotMediaSession);
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
            console.log("[mobile:media] first RTP packet received from Asterisk", {
                linkedid: session.linkedid,
                address: rinfo.address,
                port: rinfo.port,
            });
        }

        handleRtpPacket(session, packet);
    });

    socket.on("error", (error) => {
        session.lastError = error.message;
        console.error("[mobile:media] rtp socket error", {
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
                    // ignore
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
        const error = new Error("ARI external media channel was not created for mobile call");
        error.status = 502;
        throw error;
    }

    await resolveAsteriskRtpDestination(session).catch((error) => {
        session.lastError = error.message;
        console.warn("[mobile:media] Asterisk RTP destination not available yet; waiting for inbound RTP", {
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

    console.log("[mobile:media] external media ready", {
        linkedid: session.linkedid,
        bridgeId: session.bridgeId,
        externalChannelId: session.externalChannelId,
        externalHost: `${session.rtpHost}:${session.rtpPort}`,
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

    if (disconnectToneDetector && typeof disconnectToneDetector.track === "function") {
        const frame = disconnectToneDetector.createFrame(pcm48);
        const result = disconnectToneDetector.track(session, pcm48, frame, {
            enabled: true,
            hasOutput: true,
        });
        if (result && result.shouldClose) {
            console.log("[mobile:media] disconnect tone detected on mobile RTP stream, closing session", {
                linkedid: session.linkedid,
                result,
            });
            closeMediaSession(session.id, "disconnect_tone_detected").catch(() => {});
            return;
        }
    }

    if (session.recording) {
        session.recording.recordCustomerPcm(pcm48, {
            sampleRate: 48000,
            channelCount: 1,
        });
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

function sendAgentAudioToAsterisk(session, pcm48Buffer) {
    session.agentFramesReceived += 1;
    session.updatedAt = new Date().toISOString();

    if (session.agentFramesReceived === 1) {
        console.log("[mobile:media] first mobile audio frame received", {
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

    const frameSamples = Math.max(1, Math.round((8000 * env.ariExternalMediaFrameMs) / 1000));
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

async function waitForAriSession(linkedid, timeoutMs, fallbackKey = null) {
    const startedAt = Date.now();
    const maxWait = Math.max(0, Number(timeoutMs || 0));

    while (Date.now() - startedAt <= maxWait) {
        let session = ariService.getSessionByLinkedId(linkedid);
        if (!session && fallbackKey) {
            session = ariService.getSessionByLinkedId(fallbackKey);
        }

        if (session && session.inStasis) {
            return session;
        }

        await delay(35);
    }

    let fallback = ariService.getSessionByLinkedId(linkedid);
    if (!fallback && fallbackKey) {
        fallback = ariService.getSessionByLinkedId(fallbackKey);
    }
    return fallback && fallback.inStasis ? fallback : null;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    let query = `key=${encodeURIComponent(key)}`;
    if (agentId) {
        query += `&agent_id=${encodeURIComponent(agentId)}`;
    }
    query += "&client_type=mobile";
    const path = `/api/mobile/calls/${encodeURIComponent(linkedid)}/agent-ws?${query}`;

    return {
        key,
        path,
        url: publicWebSocketUrl(path),
    };
}

function ensureMediaFormatSupported() {
    if (String(env.ariExternalMediaFormat || "").toLowerCase() !== "ulaw") {
        const error = new Error(
            "The mobile media bridge currently supports ARI_EXTERNAL_MEDIA_FORMAT=ulaw only"
        );
        error.status = 422;
        throw error;
    }
}

function snapshotMediaSession(session) {
    return {
        id: session.id,
        linkedid: session.linkedid,
        owner: session.owner,
        clientType: "mobile",
        sessionAgentKey: session.sessionAgentKey,
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
        agentFramesReceived: session.agentFramesReceived,
        agentFramesDroppedNoRtp: session.agentFramesDroppedNoRtp || 0,
        browserFramesSent: session.browserFramesSent,
        activeAgentId: session.activeAgentId,
        agentWebSocketUrl: session.agentWebSocketUrl,
        agentWebSocketPath: session.agentWebSocketPath,
        hasAgentWebSocket: Boolean(session.agentWs && session.agentWs.readyState === 1),
        format: env.ariExternalMediaFormat,
        lastError: session.lastError,
    };
}

module.exports = {
    registerPendingMediaSession,
    createAgentWebSocketAccess,
    startMediaSessionByLinkedId,
    getMediaSession,
    hasSession,
    listMediaSessions,
    closeMediaSession,
    stopMediaSessionByLinkedId,
    attachAgentWebSocket,
    __test: {
        resetMediaSessions() {
            mobileSessionsById.clear();
            mobileSessionsByLinkedId.clear();
        },
    },
};

