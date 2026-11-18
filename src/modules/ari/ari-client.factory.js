const axios = require("axios");
const EventEmitter = require("events");
const WebSocket = require("ws");

const { parseAsteriskVersion, supportsExternalMediaVersion } = require("../pbx/asterisk-capabilities");

function createAriClient(options = {}) {
    const logTag = String(options.logTag || "ari").trim() || "ari";
    const getConfig = typeof options.getConfig === "function" ? options.getConfig : () => ({});
    const notifyLaravelFn = typeof options.notifyLaravelFn === "function" ? options.notifyLaravelFn : null;
    const resolveCustomLinkedId =
        typeof options.resolveCustomLinkedId === "function" ? options.resolveCustomLinkedId : null;

    let ws = null;
    let started = false;
    let connected = false;
    let reconnectTimer = null;
    let watchdogTimer = null;
    let gcTimer = null;
    let lastConnectAttemptAt = null;
    let lastEventTime = null;
    let lastPongAt = null;
    let lastError = null;
    let asteriskInfo = emptyAsteriskInfo();

    const sessionsByChannelId = new Map();
    const linkedIdAliases = new Map();
    const ariEvents = [];
    const sessionEvents = new EventEmitter();

    sessionEvents.setMaxListeners(50);

    function cfg() {
        return getConfig() || {};
    }

    function emptyAsteriskInfo() {
        return {
            rawVersion: null,
            version: null,
            major: null,
            minor: null,
            supportsExternalMedia: null,
            detectedAt: null,
            system: null,
        };
    }

    function start() {
        const current = cfg();
        if (!current.enabled) {
            return getStatus();
        }

        if (started) {
            return getStatus();
        }

        started = true;

        if (!current.username || !current.password) {
            lastError = "ARI credentials are missing";
            return getStatus();
        }

        connectWebSocket();
        startWatchdogAndGc();

        return getStatus();
    }

    function stop() {
        started = false;
        connected = false;
        asteriskInfo = emptyAsteriskInfo();
        stopWatchdogAndGc();

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
        const current = cfg();
        if (!started || !current.enabled) {
            return;
        }

        if (ws) {
            ws.removeAllListeners();
            ws.close();
            ws = null;
        }

        lastConnectAttemptAt = new Date().toISOString();

        try {
            ws = new WebSocket(buildEventsUrl(current), {
                headers: {
                    Authorization: basicAuthHeader(current),
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
            console.log(`[${logTag}] connected to ${safeBaseUrl(current)} app=${current.appName}`);
            probeAsteriskInfo().catch(() => {});
        });

        ws.on("message", (message) => {
            handleRawEvent(message).catch((error) => {
                lastError = error.message;
                console.error(`[${logTag}] event handling failed`, {
                    message: error.message,
                });
            });
        });

        ws.on("close", (code, reason) => {
            connected = false;
            console.warn(`[${logTag}] websocket closed`, {
                code,
                reason: reason ? reason.toString() : "",
            });
            scheduleReconnect();
        });

        ws.on("error", (error) => {
            connected = false;
            lastError = error.message;
            console.error(`[${logTag}] websocket error`, {
                message: error.message,
            });
        });
    }

    function scheduleReconnect() {
        const current = cfg();
        if (!started || !current.enabled || reconnectTimer) {
            return;
        }

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectWebSocket();
        }, Math.max(500, Number(current.reconnectMs || 3000)));
    }

    async function handleRawEvent(message) {
        const event = JSON.parse(Buffer.isBuffer(message) ? message.toString("utf8") : String(message));
        rememberEvent(event);

        const type = String(event.type || "");
        const channel = event.channel || {};
        const channelName = String(channel.name || "");

        if (channelName.startsWith("UnicastRTP/")) {
            return;
        }

        switch (type) {
            case "StasisStart": {
                const session = upsertSession(
                    channel,
                    {
                        status: "stasis",
                        inStasis: true,
                        wasInStasis: true,
                        startedAt: event.timestamp || new Date().toISOString(),
                        stasisArgs: Array.isArray(event.args) ? event.args : [],
                    },
                    event
                );
                rememberSessionEvent(session, event);
                notifyLaravel(session, event, "dialbegin");
                runAutoFlow(session).catch((error) => {
                    session.lastError = error.message;
                    console.error(`[${logTag}] auto flow failed`, {
                        channelId: session.channelId,
                        message: error.message,
                    });
                });
                break;
            }

            case "ChannelStateChange": {
                const session = upsertSession(channel, {}, event);
                session.status = channel.state === "Up" ? "answered" : session.status;
                rememberSessionEvent(session, event);
                if (session.inStasis && channel.state === "Up") {
                    notifyLaravel(session, event, "dialend", "ANSWER");
                }
                break;
            }

            case "ChannelEnteredBridge": {
                const session = upsertSession(
                    channel,
                    {
                        status: "bridged",
                        bridgeId: event.bridge?.id || null,
                    },
                    event
                );
                rememberSessionEvent(session, event);
                if (session.inStasis) {
                    notifyLaravel(session, event, "bridgeenter");
                }
                break;
            }

            case "ChannelLeftBridge": {
                const session = upsertSession(channel, {}, event);
                session.bridgeId = null;
                rememberSessionEvent(session, event);
                break;
            }

            case "StasisEnd":
            case "ChannelDestroyed": {
                const existing = sessionsByChannelId.get(channel.id);
                const wasStasis = Boolean(existing?.inStasis || existing?.wasInStasis);
                const session = upsertSession(
                    channel,
                    {
                        status: "ended",
                        inStasis: false,
                        endedAt: event.timestamp || new Date().toISOString(),
                    },
                    event
                );
                rememberSessionEvent(session, event);
                if (wasStasis) {
                    notifyLaravel(session, event, "hangup");
                }
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
        const current = cfg();
        if (current.autoAnswer) {
            await answerSession(session.channelId);
        }

        if (current.autoBridge) {
            await ensureBridge(session.channelId);
        }

        if (current.autoPlaybackMedia) {
            await playMedia(session.channelId, current.autoPlaybackMedia);
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
        let session = requireSession(channelId);

        if (!session.inStasis) {
            const candidate = findSessionByLinkedId(session.linkedid || channelId);
            if (candidate && candidate.inStasis && candidate.channelId !== channelId) {
                console.log(`[${logTag}] ensureBridge redirected non-stasis channel to stasis channel`, {
                    requestedChannelId: channelId,
                    stasisChannelId: candidate.channelId,
                    linkedid: session.linkedid,
                });
                session = candidate;
                channelId = session.channelId;
            }
        }

        if (!session.ariBridgeId) {
            const response = await ariRequest("post", "/bridges", {
                params: {
                    type: "mixing",
                    name: `ariana-${channelId}`,
                },
            });

            session.ariBridgeId = response.data?.id || response.data?.bridge?.id || null;
            session.bridgeId = session.ariBridgeId || session.bridgeId;
        }

        const bridgeId = session.ariBridgeId || session.bridgeId;

        if (!bridgeId) {
            const error = new Error("ARI bridge was not created");
            error.status = 502;
            throw error;
        }

        try {
            await addChannelToBridgeWithRetry(bridgeId, channelId);
        } catch (error) {
            const message = String(error?.response?.data?.message || error?.message || "").toLowerCase();
            if (message.includes("bridge not in stasis")) {
                const response = await ariRequest("post", "/bridges", {
                    params: {
                        type: "mixing",
                        name: `ariana-${channelId}-${Date.now()}`,
                    },
                });
                session.ariBridgeId = response.data?.id || response.data?.bridge?.id;
                session.bridgeId = session.ariBridgeId;
                await addChannelToBridgeWithRetry(session.ariBridgeId, channelId);
            } else {
                throw error;
            }
        }

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

    async function startMoh(channelId, mohClass = "default") {
        const session = requireSession(channelId);

        try {
            await ariRequest("post", `/channels/${encodeURIComponent(channelId)}/moh`, {
                params: {
                    mohClass: mohClass || "default",
                },
            });
            session.mohActive = true;
        } catch (error) {
            console.warn(`[${logTag}] startMoh error`, {
                channelId,
                message: error?.response?.data?.message || error?.message,
            });
        }

        session.updatedAt = new Date().toISOString();

        return snapshotSession(session);
    }

    async function stopMoh(channelIdOrLinkedid) {
        const target = String(channelIdOrLinkedid || "").trim();
        const session = findSessionByLinkedId(target) || sessionsByChannelId.get(target);

        if (!session) {
            return null;
        }

        try {
            await ariRequest("delete", `/channels/${encodeURIComponent(session.channelId)}/moh`);
            session.mohActive = false;
        } catch (_) {
            // Best effort MOH cleanup.
        }

        session.updatedAt = new Date().toISOString();

        return snapshotSession(session);
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

    async function probeAsteriskInfo() {
        const current = cfg();
        if (!current.enabled || !current.username || !current.password) {
            return null;
        }

        try {
            const response = await axios.request({
                method: "GET",
                url: `${restBaseUrl(current)}/asterisk/info`,
                auth: {
                    username: current.username,
                    password: current.password,
                },
                timeout: Math.min(Number(current.requestTimeoutMs) || 15000, 5000),
                headers: {
                    Accept: "application/json",
                },
            });

            const rawVersion = response?.data?.system?.version || null;
            const parsed = parseAsteriskVersion(rawVersion);
            asteriskInfo = {
                rawVersion: parsed.raw,
                version: parsed.parsedVersion,
                major: parsed.major,
                minor: parsed.minor,
                supportsExternalMedia: supportsExternalMediaVersion(parsed),
                detectedAt: parsed.detected ? new Date().toISOString() : null,
                system: response?.data?.system || null,
            };

            if (parsed.detected) {
                console.log(`[${logTag}] Asterisk info detected`, {
                    version: parsed.parsedVersion,
                    supportsExternalMedia: asteriskInfo.supportsExternalMedia,
                });
            }

            return asteriskInfo;
        } catch (error) {
            console.warn(`[${logTag}] Asterisk info probe failed`, {
                message: error.message,
            });
            return null;
        }
    }

    async function ariRequest(method, path, requestOptions = {}) {
        const current = cfg();
        ensureReady(current);

        return axios.request({
            method,
            url: `${restBaseUrl(current)}${path}`,
            auth: {
                username: current.username,
                password: current.password,
            },
            timeout: Number(current.requestTimeoutMs || 15000),
            params: requestOptions.params,
            data: requestOptions.data,
            headers: {
                Accept: "application/json",
            },
        });
    }

    function getStatus() {
        const current = cfg();
        return {
            enabled: Boolean(current.enabled),
            started,
            connected,
            baseUrl: safeBaseUrl(current),
            appName: current.appName || "",
            buildVersion: current.buildVersion || "",
            bridgeWaitMs: current.bridgeWaitMs,
            stasisWaitMs: current.stasisWaitMs,
            lastConnectAttemptAt,
            lastEventTime,
            lastPongAt: lastPongAt ? new Date(lastPongAt).toISOString() : null,
            lastError,
            asteriskVersion: asteriskInfo.version,
            asteriskRawVersion: asteriskInfo.rawVersion,
            asteriskDetectedAt: asteriskInfo.detectedAt,
            supportsExternalMedia: asteriskInfo.supportsExternalMedia,
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

    function resolveLinkedIdAlias(key) {
        const normalized = String(key || "").trim();
        if (!normalized) {
            return null;
        }

        const entry = linkedIdAliases.get(normalized);
        if (!entry) {
            return null;
        }

        if (Date.now() - entry.updatedAtMs > 15 * 60 * 1000) {
            linkedIdAliases.delete(normalized);
            return null;
        }

        return entry.linkedid;
    }

    function registerLinkedIdAlias(key, canonicalLinkedId) {
        const cleanKey = String(key || "").trim();
        const canonical = String(canonicalLinkedId || "").trim();
        if (!cleanKey || !canonical || cleanKey === canonical) {
            return;
        }

        linkedIdAliases.set(cleanKey, {
            linkedid: canonical,
            updatedAtMs: Date.now(),
        });

        for (const session of sessionsByChannelId.values()) {
            if (
                session.channelId === cleanKey ||
                session.channel?.name === cleanKey ||
                session.linkedid === cleanKey
            ) {
                session.linkedid = canonical;
            }
        }
    }

    function upsertSession(channel, attributes = {}, event = null) {
        const channelId = channel.id;

        if (!channelId) {
            const error = new Error("ARI channel event does not include channel.id");
            error.status = 422;
            throw error;
        }

        const now = new Date().toISOString();
        const existing = sessionsByChannelId.get(channelId);
        const customLinkedId = resolveCustomLinkedId ? resolveCustomLinkedId(channel, event) : null;
        const resolvedAlias =
            customLinkedId ||
            resolveLinkedIdAlias(channelId) ||
            resolveLinkedIdAlias(channel.name) ||
            (channel.linkedid ? resolveLinkedIdAlias(channel.linkedid) : null);

        const session = existing || {
            id: channelId,
            channelId,
            linkedid: resolvedAlias || channel.linkedid || channel.id,
            status: "created",
            inStasis: false,
            wasInStasis: false,
            createdAt: now,
            updatedAt: now,
            answeredAt: null,
            endedAt: null,
            bridgeId: null,
            ariBridgeId: null,
            lastPlaybackId: null,
            lastError: null,
            stasisArgs: [],
            channel: normalizeChannel(channel),
            events: [],
        };

        session.linkedid = resolvedAlias || existing?.linkedid || channel.linkedid || channel.id;
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
        const current = cfg();
        const maxEvents = Math.max(10, Number(current.maxEvents || 300));
        const summary = summarizeEvent(event);

        session.events.push(summary);

        while (session.events.length > maxEvents) {
            session.events.shift();
        }

        sessionEvents.emit("session-event", snapshotSession(session), summary, event);
    }

    function rememberEvent(event) {
        const current = cfg();
        const maxEvents = Math.max(10, Number(current.maxEvents || 300));
        lastEventTime = event.timestamp || new Date().toISOString();

        ariEvents.push(summarizeEvent(event));

        while (ariEvents.length > maxEvents) {
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
            inStasis: Boolean(session.inStasis),
            wasInStasis: Boolean(session.wasInStasis),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            answeredAt: session.answeredAt,
            endedAt: session.endedAt,
            bridgeId: session.bridgeId,
            ariBridgeId: session.ariBridgeId || null,
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
        const current = cfg();
        if (!notifyLaravelFn || !current.laravelEventsEnabled) {
            return;
        }

        if (!session?.inStasis && !session?.wasInStasis) {
            return;
        }

        const channelName = String(session?.channel?.name || event?.channel?.name || session?.channelId || "");
        if (channelName.startsWith("UnicastRTP/")) {
            return;
        }

        const eventPayload = toTrunkEvent(session, event, trunkEventName, dialStatus);
        const payload = {
            event: eventPayload,
            summary: toTrunkSummary(session, eventPayload),
            source: "ariana-asterisk-ari",
        };

        if (eventPayload.outbound_call_id) {
            payload.outbound_call_id = eventPayload.outbound_call_id;
            payload.direction = "OUTBOUND";
        }

        Promise.resolve(notifyLaravelFn(payload))
            .then((response) => {
                console.log(`[${logTag}:laravel] trunk event accepted`, {
                    linkedid: session.linkedid,
                    event: trunkEventName,
                    response,
                });
            })
            .catch((error) => {
                console.error(`[${logTag}] Laravel trunk event callback failed`, {
                    linkedid: session.linkedid,
                    event: trunkEventName,
                    message: error.message,
                    status: error.response?.status,
                });
            });
    }

    function toTrunkEvent(session, event, trunkEventName, dialStatus = "") {
        const channel = session.channel || {};

        let outboundCallId = "";
        if (Array.isArray(session.stasisArgs)) {
            const found = session.stasisArgs.find((arg) =>
                /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(arg))
            );
            if (found) {
                outboundCallId = String(found);
            }
        }

        const payload = {
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

        if (outboundCallId) {
            payload.outbound_call_id = outboundCallId;
            payload.direction = "OUTBOUND";
        }

        return payload;
    }

    function toTrunkSummary(session, eventPayload) {
        const ended = session.status === "ended";
        const bridged = Boolean(session.bridgeId) || session.status === "bridged";
        const answered = Boolean(session.answeredAt) || ["answered", "bridged"].includes(session.status);

        const summary = {
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

        if (eventPayload.outbound_call_id) {
            summary.outbound_call_id = eventPayload.outbound_call_id;
            summary.direction = "OUTBOUND";
        }

        return summary;
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
        const current = cfg();
        const startedAt = Date.now();
        const maxWait = Math.max(0, Number(current.bridgeWaitMs || current.stasisWaitMs || 0));
        let lastBridgeError = null;

        while (Date.now() - startedAt <= maxWait) {
            try {
                await ariRequest("post", `/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
                    params: {
                        channel: channelId,
                    },
                });

                if (lastBridgeError) {
                    console.log(`[${logTag}] bridge addChannel succeeded after retry`, {
                        channelId,
                        bridgeId,
                        waitedMs: Date.now() - startedAt,
                    });
                }

                return;
            } catch (error) {
                lastBridgeError = error;

                if (!isRetryableBridgeAddChannelError(error)) {
                    throw error;
                }

                if (Date.now() - startedAt < 100 || (Date.now() - startedAt) % 1000 < 60) {
                    console.warn(`[${logTag}] bridge addChannel waiting for Stasis`, {
                        channelId,
                        bridgeId,
                        waitedMs: Date.now() - startedAt,
                        status: error?.response?.status,
                        message: error?.response?.data?.message || error?.message,
                    });
                }

                if (Date.now() - startedAt >= maxWait) {
                    break;
                }

                await delay(50);
            }
        }

        console.warn(`[${logTag}] bridge addChannel failed after wait`, {
            channelId,
            bridgeId,
            waitedMs: Date.now() - startedAt,
            status: lastBridgeError?.response?.status,
            message: lastBridgeError?.message,
            data: lastBridgeError?.response?.data,
        });

        throw lastBridgeError;
    }

    function isRetryableBridgeAddChannelError(error) {
        const status = Number(error?.response?.status || error?.status || 0);
        const message = String(error?.response?.data?.message || error?.message || "").toLowerCase();

        if (status === 409 && (message.includes("channel not in stasis") || (message.includes("not in stasis") && !message.includes("bridge not in stasis")))) {
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

        const allSessions = Array.from(sessionsByChannelId.values());
        const aliasedKeys = new Set();
        for (const [aliasKey, entry] of linkedIdAliases.entries()) {
            if (entry && entry.linkedid === target && Date.now() - entry.updatedAtMs <= 15 * 60 * 1000) {
                aliasedKeys.add(aliasKey);
            }
        }

        const directMatches = allSessions.filter((session) => {
            if (session.channelId === target || session.linkedid === target) {
                return true;
            }
            if (session.channel?.name === target) {
                return true;
            }
            if (aliasedKeys.has(session.channelId) || (session.channel?.name && aliasedKeys.has(session.channel.name))) {
                return true;
            }
            if (Array.isArray(session.stasisArgs) && session.stasisArgs.some((arg) => String(arg) === target)) {
                return true;
            }
            return false;
        });

        const relatedLinkedIds = new Set();
        relatedLinkedIds.add(target);
        for (const match of directMatches) {
            if (match.linkedid) {
                relatedLinkedIds.add(match.linkedid);
            }
        }

        const candidateSet = new Set(directMatches);
        for (const session of allSessions) {
            if (session.linkedid && relatedLinkedIds.has(session.linkedid)) {
                candidateSet.add(session);
            }
        }

        const candidates = Array.from(candidateSet);
        if (candidates.length === 0) {
            return null;
        }

        candidates.sort((left, right) => {
            const score = (s) => {
                let pts = 0;
                const isEnded = s.status === "ended";
                const inStasis = Boolean(s.inStasis);
                const wasStasis = Boolean(s.wasInStasis);
                const hasStasisArgs = Array.isArray(s.stasisArgs) && s.stasisArgs.length > 0;

                if (!isEnded && inStasis) pts += 10000;
                else if (!isEnded && wasStasis) pts += 5000;
                else if (!isEnded && hasStasisArgs) pts += 3000;
                else if (!isEnded) pts += 1000;
                else if (inStasis) pts += 500;
                else if (wasStasis) pts += 200;

                return pts;
            };

            const diff = score(right) - score(left);
            if (diff !== 0) {
                return diff;
            }

            const timeRight = new Date(right.updatedAt || right.createdAt).getTime() || 0;
            const timeLeft = new Date(left.updatedAt || left.createdAt).getTime() || 0;
            return timeRight - timeLeft;
        });

        return candidates[0] || null;
    }

    function ensureReady(current) {
        if (!current.enabled) {
            const error = new Error("ARI is disabled");
            error.status = 409;
            throw error;
        }

        if (!current.username || !current.password) {
            const error = new Error("ARI credentials are missing");
            error.status = 503;
            throw error;
        }
    }

    function buildEventsUrl(current) {
        const explicit = current.wsUrl ? new URL(current.wsUrl) : new URL("/ari/events", wsBaseUrl(current));

        explicit.searchParams.set("app", current.appName || "ariana-trunk");
        explicit.searchParams.set("subscribeAll", "true");
        explicit.searchParams.set("api_key", `${current.username}:${current.password}`);

        return explicit.toString();
    }

    function restBaseUrl(current) {
        return `${String(current.baseUrl || "http://127.0.0.1:8088").replace(/\/$/, "")}/ari`;
    }

    function wsBaseUrl(current) {
        const base = String(current.baseUrl || "http://127.0.0.1:8088").replace(/\/$/, "");

        if (base.startsWith("https://")) {
            return `wss://${base.slice(8)}`;
        }

        if (base.startsWith("http://")) {
            return `ws://${base.slice(7)}`;
        }

        return base;
    }

    function safeBaseUrl(current) {
        return String(current.baseUrl || "").replace(/\/$/, "");
    }

    function basicAuthHeader(current) {
        return `Basic ${Buffer.from(`${current.username}:${current.password}`).toString("base64")}`;
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

    function restart() {
        stop();
        return start();
    }

    function startWatchdogAndGc() {
        if (!watchdogTimer) {
            watchdogTimer = setInterval(() => {
                if (!started || !ws) {
                    return;
                }
                if (ws.readyState === WebSocket.OPEN) {
                    if (!ws.__arianaPongBound) {
                        ws.__arianaPongBound = true;
                        lastPongAt = Date.now();
                        ws.on("pong", () => {
                            lastPongAt = Date.now();
                        });
                    }
                    try {
                        ws.ping();
                    } catch (_err) {
                        // handled below by stale check
                    }
                    const now = Date.now();
                    const lastActivityMs = Math.max(
                        lastPongAt || 0,
                        lastEventTime ? Date.parse(lastEventTime) || 0 : 0
                    );
                    if (lastActivityMs > 0 && now - lastActivityMs > 35000) {
                        console.warn(`[${logTag}:watchdog] WebSocket unresponsive to ping/events for >35s; terminating for reconnect`);
                        lastError = "ARI WebSocket watchdog ping timeout";
                        connected = false;
                        try {
                            ws.terminate();
                        } catch (_err) {
                            // ignore terminate error
                        }
                        scheduleReconnect();
                    }
                }
            }, 15000);
            if (typeof watchdogTimer.unref === "function") {
                watchdogTimer.unref();
            }
        }

        if (!gcTimer) {
            gcTimer = setInterval(() => {
                pruneStaleAriSessions();
            }, 60000);
            if (typeof gcTimer.unref === "function") {
                gcTimer.unref();
            }
        }
    }

    function stopWatchdogAndGc() {
        if (watchdogTimer) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }
        if (gcTimer) {
            clearInterval(gcTimer);
            gcTimer = null;
        }
    }

    function pruneStaleAriSessions(maxAgeMs = 15 * 60 * 1000) {
        const cutoff = Date.now() - maxAgeMs;
        let removed = 0;

        for (const [channelId, session] of sessionsByChannelId.entries()) {
            if (session.status !== "ended") {
                continue;
            }
            const endedMs = Date.parse(session.endedAt || session.updatedAt || session.createdAt || "");
            if (Number.isFinite(endedMs) && endedMs < cutoff) {
                sessionsByChannelId.delete(channelId);
                removed += 1;
            }
        }

        for (const [aliasKey, entry] of linkedIdAliases.entries()) {
            if (!entry || Date.now() - entry.updatedAtMs > maxAgeMs) {
                linkedIdAliases.delete(aliasKey);
            }
        }

        return removed;
    }

    return {
        start,
        stop,
        restart,
        getStatus,
        getEvents,
        listSessions,
        getSession,
        getSessionByLinkedId,
        registerLinkedIdAlias,
        ingestEventForTest: (payload) => handleRawEvent(typeof payload === "string" ? payload : JSON.stringify(payload)),
        onSessionEvent,
        answerSession,
        answerCallByLinkedId,
        startMoh,
        stopMoh,
        ensureBridge,
        ensureCallBridgeByLinkedId,
        playMedia,
        playCallMediaByLinkedId,
        hangupSession,
        hangupCallByLinkedId,
        ariRequest,
        probeAsteriskInfo,
    };
}

module.exports = {
    createAriClient,
};

