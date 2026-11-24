const AsteriskManager = require("asterisk-manager");
const EventEmitter = require("events");
const env = require("../../config/env");
const laravelService = require("../laravel/laravel.service");
const auditLog = require("../audit/audit-log.service");
const callState = require("./call-state.service");
const { classifyChannel, isBridgeLegChannel } = require("./call-state.service");
const queuePresence = require("./queue-presence.service");
const { parseAsteriskVersion } = require("./asterisk-capabilities");

let gcTimer = null;

const trackedEvents = new Set([
    "dialbegin",
    "dialend",
    "dialstate",
    "bridgeenter",
    "bridgeleave",
    "hangup",
    "queuecallerjoin",
    "queuecallerleave",
    "queuecallerabandon",
    "agentcalled",
    "agentconnect",
    "agentcomplete",
    "agentdump",
    "agentringernoanswer",
    "queuememberpaused",
    "queuememberpause",
]);
const conciseRawEvents = new Set([
    "dialbegin",
    "dialend",
    "dialstate",
    "bridgeenter",
    "bridgeleave",
    "hangup",
    "hanguprequest",
    "softhanguprequest",
    "newchannel",
    "newstate",
    "queuecallerjoin",
    "queuecallerleave",
    "queuecallerabandon",
    "agentcalled",
    "agentconnect",
    "agentcomplete",
    "queuememberpaused",
]);

let ami = null;
let started = false;
let connected = false;
let lastAmiEventTime = null;
let lastAmiError = null;
let amiAsteriskRawVersion = null;
let amiAsteriskDetectedAt = null;
let lastQueueStatusSnapshot = null;

const callEvents = [];
const callsByLinkedId = new Map();
const rawEventsByLinkedId = new Map();
const actionsByLinkedId = new Map();
const lifecycleEvents = new EventEmitter();
const eventMetadataResolvers = new Set();

lifecycleEvents.setMaxListeners(50);

function start() {
    if (!env.pbxAmiEnabled) {
        return getStatus();
    }

    if (started) {
        return getStatus();
    }

    if (!env.pbxAmiUsername || !env.pbxAmiPassword) {
        lastAmiError = "PBX AMI credentials are missing";
        return getStatus();
    }

    ami = new AsteriskManager(
        env.pbxAmiPort,
        env.pbxAmiHost,
        env.pbxAmiUsername,
        env.pbxAmiPassword,
        env.pbxAmiReconnect
    );

    ami.on("connect", () => {
        connected = true;
        lastAmiError = null;
        console.log(`[pbx] AMI connected to ${env.pbxAmiHost}:${env.pbxAmiPort}`);
        enableAmiEvents();
        probeAmiAsteriskVersion().catch(() => {});
    });

    ami.on("disconnect", () => {
        connected = false;
        console.warn("[pbx] AMI disconnected");
    });

    ami.on("error", (error) => {
        connected = false;
        lastAmiError = error.message || String(error);
        console.error("[pbx] AMI error", error);
    });

    ami.on("managerevent", handleManagerEvent);
    ami.keepConnected();
    started = true;

    if (!gcTimer) {
        gcTimer = setInterval(() => {
            pruneStaleTrackingData();
        }, 60000);
        if (typeof gcTimer.unref === "function") {
            gcTimer.unref();
        }
    }

    return getStatus();
}

function stop() {
    if (gcTimer) {
        clearInterval(gcTimer);
        gcTimer = null;
    }

    if (ami && typeof ami.disconnect === "function") {
        ami.disconnect();
    }

    ami = null;
    started = false;
    connected = false;
    amiAsteriskRawVersion = null;
    amiAsteriskDetectedAt = null;
    lastQueueStatusSnapshot = null;
}

function restart() {
    stop();
    queuePresence.reset();
    return start();
}

function pruneStaleTrackingData() {
    callState.pruneStaleCalls();
    const cutoffMs = Date.now() - 15 * 60 * 1000;

    for (const [linkedid, call] of callsByLinkedId.entries()) {
        const lastMs = Date.parse(call.lastEventTime || call.firstEventTime || "");
        const stateCall = callState.getCall(linkedid);
        const terminal =
            ["HANGUP", "ABANDONED", "COMPLETED", "BUSY", "NOANSWER", "CANCEL", "CHANUNAVAIL"].includes(
                String(call.status || "").toUpperCase()
            ) || (stateCall && ["ENDED", "ABANDONED", "CANCELLED", "NOANSWER", "BUSY", "FAILED"].includes(stateCall.status));

        if (!stateCall || (terminal && Number.isFinite(lastMs) && lastMs < cutoffMs)) {
            callsByLinkedId.delete(linkedid);
            rawEventsByLinkedId.delete(linkedid);
            actionsByLinkedId.delete(linkedid);
        }
    }
}

function extractExtensionNumber(value) {
    if (!value) {
        return "";
    }

    const text = String(value).trim();
    if (isBridgeLegChannel(text) || /^88\d{8}$/.test(text) || /^\d{6,}$/.test(text) || /^\d+\.\d+$/.test(text)) {
        return "";
    }

    const match = text.match(/(?:Local\/|PJSIP\/|SIP\/)?(\d{2,5})(?:[@\-\/;,]|$)/i);

    return match ? match[1] : "";
}

function handleManagerEvent(event) {
    const eventName = normalizeEventName(event);
    const raw = normalizeRawEvent(event, eventName);

    rememberRawEvent(raw);
    lifecycleEvents.emit("manager-event", raw);

    if (shouldLogRawEvent(raw)) {
        console.log("[pbx:event:raw]", raw);
    }

    if (!trackedEvents.has(eventName)) {
        return;
    }

    const now = new Date().toISOString();
    lastAmiEventTime = now;

    const agentCalledRaw =
        event.agentcalled ||
        event.AgentCalled ||
        event.agentname ||
        event.AgentName ||
        event.membername ||
        event.MemberName ||
        event.member ||
        event.Member ||
        event.interface ||
        event.Interface ||
        "";
    const queueName = String(event.queue || event.Queue || "").trim();
    const rawDestChannel = event.destchannel || event.DestChannel || "";
    const isBridgeEvent = isBridgeLegChannel(rawDestChannel) || isBridgeLegChannel(event.channel || event.Channel || "");
    let agentExtension = isBridgeEvent ? "" : extractExtensionNumber(agentCalledRaw);
    if (!agentExtension && !isBridgeEvent && rawDestChannel) {
        agentExtension = extractExtensionNumber(rawDestChannel);
    }
    const destCandidate = event.destination || event.Destination || "";
    if (!agentExtension && !isBridgeEvent && destCandidate && String(destCandidate) !== queueName) {
        agentExtension = extractExtensionNumber(destCandidate);
    }
    const extenCandidate = event.exten || event.Exten || "";
    if (!agentExtension && !isBridgeEvent && extenCandidate && String(extenCandidate) !== queueName) {
        agentExtension = extractExtensionNumber(extenCandidate);
    }

    const normalized = {
        time: now,
        event: eventName,
        caller: event.calleridnum || event.CallerIDNum || "",
        callerName: event.calleridname || event.CallerIDName || "",
        channel: event.channel || event.Channel || "",
        destination:
            event.destination ||
            event.Destination ||
            event.dialstring ||
            event.DialString ||
            event.exten ||
            event.Exten ||
            agentExtension ||
            "",
        destChannel: event.destchannel || event.DestChannel || "",
        dialStatus: event.dialstatus || event.DialStatus || "",
        bridgeUniqueid: event.bridgeuniqueid || event.BridgeUniqueid || "",
        uniqueid: event.uniqueid || event.Uniqueid || "",
        linkedid:
            event.linkedid ||
            event.Linkedid ||
            event.uniqueid ||
            event.Uniqueid ||
            "",
        cause: event.cause || event.Cause || "",
        causeTxt:
            event["cause-txt"] ||
            event.causetxt ||
            event.CauseTxt ||
            "",
        queue: queueName,
        agentCalled: agentCalledRaw,
        agentExtension,
        queuePosition: event.position || event.Position || "",
        queueCount: event.count || event.Count || "",
        holdTime: event.holdtime || event.HoldTime || "",
        talkTime: event.talktime || event.TalkTime || "",
        reason: event.reason || event.Reason || "",
    };

    logTrackedEvent(normalized);
    callEvents.push(normalized);

    while (callEvents.length > env.pbxMaxEvents) {
        callEvents.shift();
    }

    updateCallSummary(normalized);
    logCallSummary(normalized.linkedid);
    notifyRedirectStasisEarlyEnd(normalized);
    lifecycleEvents.emit("manager-event", normalized);
    notifyLaravelV2(normalized);
}

function normalizeEventName(event) {
    return String(event.event || event.Event || "").toLowerCase().trim();
}

function normalizeRawEvent(event, eventName = normalizeEventName(event)) {
    return {
        time: new Date().toISOString(),
        event: eventName || event.event || event.Event || "",
        actionId: event.actionid || event.ActionID || "",
        response: event.response || event.Response || "",
        reason: event.reason || event.Reason || "",
        channel: event.channel || event.Channel || "",
        caller: event.calleridnum || event.CallerIDNum || "",
        callerName: event.calleridname || event.CallerIDName || "",
        destination:
            event.destination ||
            event.Destination ||
            event.dialstring ||
            event.DialString ||
            event.exten ||
            event.Exten ||
            "",
        destChannel: event.destchannel || event.DestChannel || "",
        dialStatus: event.dialstatus || event.DialStatus || "",
        queue: event.queue || event.Queue || "",
        extension: event.extension || event.Extension || event.exten || event.Exten || "",
        destExtension: event.destextension || event.DestExtension || "",
        memberName: event.membername || event.MemberName || event.interface || event.Interface || "",
        context: event.context || event.Context || "",
        channelStateDesc: event.channelstatedesc || event.ChannelStateDesc || "",
        bridgeNumChannels: event.bridgenumchannels || event.BridgeNumChannels || "",
        state: event.channelstatedesc || event.ChannelStateDesc || event.state || event.State || "",
        application: event.application || event.Application || "",
        appData: event.appdata || event.AppData || "",
        cause: event.cause || event.Cause || "",
        causeTxt: event["cause-txt"] || event.causetxt || event.CauseTxt || "",
        linkedid:
            event.linkedid ||
            event.Linkedid ||
            event.uniqueid ||
            event.Uniqueid ||
            "",
        uniqueid: event.uniqueid || event.Uniqueid || "",
        variable: event.variable || event.Variable || "",
        value: event.value || event.Value || "",
    };
}

function rememberRawEvent(event) {
    if (!event.linkedid) {
        return;
    }

    if (!rawEventsByLinkedId.has(event.linkedid)) {
        rawEventsByLinkedId.set(event.linkedid, []);
    }

    const items = rawEventsByLinkedId.get(event.linkedid);
    items.push(event);

    while (items.length > env.pbxMaxEvents) {
        items.shift();
    }
}

function shouldLogRawEvent(event) {
    if (!env.pbxLogRawEvents) {
        return false;
    }

    if (env.pbxLogVerboseRawEvents) {
        return true;
    }

    if (!event.linkedid) {
        return false;
    }

    return conciseRawEvents.has(String(event.event || "").toLowerCase());
}

function updateCallSummary(event) {
    if (!event.linkedid) {
        return;
    }

    if (!callsByLinkedId.has(event.linkedid)) {
        callsByLinkedId.set(event.linkedid, {
            linkedid: event.linkedid,
            firstEventTime: event.time,
            lastEventTime: event.time,
            from: "",
            to: "",
            callerName: "",
            status: "IN_PROGRESS",
            answered: false,
            bridged: false,
            hangupCause: "",
            hangupText: "",
            result: "in_progress",
            channels: [],
            events: [],
        });
    }

    const call = callsByLinkedId.get(event.linkedid);
    call.lastEventTime = event.time;

    if (event.caller && !call.from && !isInternalProbeExtension(event.caller)) {
        call.from = event.caller;
    }

    if (!call.from && event.caller) {
        call.from = event.caller;
    }

    if (!call.callerName && event.callerName) {
        call.callerName = event.callerName;
    }

    if (!call.to) {
        call.to = event.destination || event.destChannel || "";
    }

    addUnique(call.channels, event.channel);
    addUnique(call.channels, event.destChannel);
    call.events.push(event);

    switch (event.event) {
        case "dialbegin":
            call.from = call.from || event.caller || "";
            if (!isBridgeLegChannel(event.destChannel) && !isBridgeLegChannel(event.channel)) {
                call.to = call.to || event.destination || "";
            }
            break;
        case "dialend":
            if (event.dialStatus) {
                const isSubChannel = String(event.channel || "").startsWith("Local/") || String(event.destChannel || "").startsWith("Local/");
                if (!isSubChannel || event.dialStatus === "ANSWER") {
                    call.status = event.dialStatus;
                }
            }
            if (event.dialStatus === "ANSWER") {
                call.answered = true;
            }
            break;
        case "bridgeenter":
            call.bridged = true;
            call.wasBridged = true;
            call.answered = true;
            call.status = "ANSWER";
            break;
        case "queuecallerjoin":
            call.queue = event.queue || call.queue || "";
            call.queuePosition = event.queuePosition || call.queuePosition || "";
            if (call.status === "IN_PROGRESS" || !call.status) {
                call.status = "QUEUE_WAITING";
            }
            break;
        case "agentcalled":
            call.queue = event.queue || call.queue || "";
            call.agentExtension = event.agentExtension || call.agentExtension || "";
            call.agentCalled = event.agentCalled || call.agentCalled || "";
            call.to = event.agentExtension || call.to || "";
            call.status = "RINGING";
            break;
        case "agentconnect":
            call.queue = event.queue || call.queue || "";
            call.agentExtension = event.agentExtension || call.agentExtension || "";
            call.answered = true;
            call.status = "ANSWER";
            break;
        case "agentcomplete":
            call.status = "COMPLETED";
            break;
        case "queuecallerabandon": {
            const actions = actionsByLinkedId.get(call.linkedid) || [];
            const isRedirectedToStasis = actions.some((item) =>
                item.action === "redirect_stasis_requested" || item.action === "redirect_stasis_sent"
            );
            if (isRedirectedToStasis || call.answered || call.bridged || call.wasBridged || call.status === "ANSWER") {
                console.log("[pbx:queue] queuecallerabandon ignored because call was redirected/answered in Stasis", {
                    linkedid: call.linkedid,
                    status: call.status,
                    answered: call.answered,
                    bridged: call.bridged,
                });
                break;
            }
            call.status = "ABANDONED";
            break;
        }
        case "queuecallerleave": {
            const actions = actionsByLinkedId.get(call.linkedid) || [];
            const isRedirectedToStasis = actions.some((item) =>
                item.action === "redirect_stasis_requested" || item.action === "redirect_stasis_sent"
            );
            if (isRedirectedToStasis || call.answered || call.bridged || call.wasBridged || call.status === "ANSWER") {
                break;
            }
            if (call.status === "QUEUE_WAITING") {
                call.status = "QUEUE_LEFT";
            }
            break;
        }
        case "hangup":
            call.hangupCause = event.cause || call.hangupCause;
            call.hangupText = event.causeTxt || call.hangupText;
            if (isNonTerminalHangupEvent(event, call)) {
                break;
            }
            call.status = "HANGUP";
            call.bridged = false;
            break;
        default:
            break;
    }

    call.result = buildCallResult(call);
}

function isInternalProbeExtension(value) {
    return false;
}

function addUnique(items, value) {
    if (value && !items.includes(value)) {
        items.push(value);
    }
}

function buildCallResult(call) {
    if (call.status === "HANGUP") {
        return "hangup";
    }

    if (call.answered || call.bridged || call.status === "ANSWER") {
        return "answered";
    }

    if (call.status === "RINGING") {
        return "ringing";
    }

    if (call.status === "QUEUE_WAITING") {
        return "queue_waiting";
    }

    if (call.status === "ABANDONED") {
        return "abandoned";
    }

    if (call.status === "COMPLETED") {
        return "completed";
    }

    if (call.status === "BUSY") {
        return "busy";
    }

    if (call.status === "NOANSWER") {
        return "no_answer";
    }

    if (call.status === "CANCEL") {
        return "cancelled";
    }

    if (call.status === "CHANUNAVAIL") {
        return "channel_unavailable";
    }

    return "in_progress";
}

function getStatus() {
    const parsed = parseAsteriskVersion(amiAsteriskRawVersion);

    return {
        enabled: env.pbxAmiEnabled,
        started,
        connected,
        host: env.pbxAmiHost,
        port: env.pbxAmiPort,
        username: env.pbxAmiUsername,
        outboundEnabled: env.trunkOutboundEnabled,
        configuredAnswerMode: env.pbxAnswerMode,
        asteriskVersion: parsed.parsedVersion,
        asteriskRawVersion: parsed.raw,
        asteriskDetectedAt: amiAsteriskDetectedAt,
        activeCallsCount: callState.getActiveCount(),
        trackedCallsCount: callsByLinkedId.size,
        lastAmiEventTime,
        lastAmiError,
    };
}

function getCallEvents() {
    return [...callEvents];
}

function getCallsSummary() {
    return [...callsByLinkedId.values()]
        .map((call) => ({
            linkedid: call.linkedid,
            firstEventTime: call.firstEventTime,
            lastEventTime: call.lastEventTime,
            from: call.from,
            to: call.to,
            callerName: call.callerName,
            status: call.status,
            answered: call.answered,
            bridged: call.bridged,
            hangupCause: call.hangupCause,
            hangupText: call.hangupText,
            result: call.result,
            channels: [...call.channels],
            totalEvents: call.events.length,
        }))
        .sort((left, right) => new Date(right.lastEventTime) - new Date(left.lastEventTime));
}

function getCallByLinkedId(linkedid) {
    const call = callsByLinkedId.get(linkedid);

    if (!call) {
        return null;
    }

    return {
        ...call,
        channels: [...call.channels],
        events: [...call.events],
    };
}

function getCallDiagnostics(linkedid) {
    const call = getCallByLinkedId(linkedid);

    if (!call) {
        return null;
    }

    const rawEvents = rawEventsByLinkedId.get(linkedid) || [];
    const actions = actionsByLinkedId.get(linkedid) || [];
    const allEvents = [...rawEvents, ...call.events];
    const hasAnswer = allEvents.some((event) => String(event.dialStatus || "").toUpperCase() === "ANSWER");
    const hasBridge = allEvents.some((event) => ["bridgeenter", "bridgeleave"].includes(String(event.event || "").toLowerCase()));
    const hangups = allEvents.filter((event) => String(event.event || "").toLowerCase().includes("hangup"));
    const requestedConnect = actions.some((action) => action.action === "connect_extension_requested");
    const alreadyDialing = actions.some((action) => action.action === "connect_extension_already_dialing");
    const redirectSent = actions.some((action) => action.action === "connect_extension_redirect_sent");

    return {
        linkedid,
        summary: call,
        diagnosis: buildDiagnosis({
            call,
            hasAnswer,
            hasBridge,
            hangups,
            requestedConnect,
            alreadyDialing,
            redirectSent,
        }),
        facts: {
            hasAnswer,
            hasBridge,
            requestedConnect,
            alreadyDialing,
            redirectSent,
            hangupCount: hangups.length,
            rawEventCount: rawEvents.length,
            trackedEventCount: call.events.length,
            actionCount: actions.length,
        },
        actions,
        recentRawEvents: rawEvents.slice(-80),
        recentTrackedEvents: call.events.slice(-40),
    };
}

async function getAmiStatus() {
    ensureReady();
    console.log("[pbx:ami-action] Status");

    return runAmiAction({
        Action: "Status",
    });
}

async function hangupCall(linkedid, reason = "laravel_hangup") {
    validateRequired({ linkedid });
    ensureReady();
    console.log("[pbx:action] hangup requested", { linkedid, reason });
    rememberAction(linkedid, "hangup_requested", { reason });

    const call = callsByLinkedId.get(linkedid);

    try {
        const ariMediaService = require("../ari/ari-media.service");
        if (ariMediaService && typeof ariMediaService.closeMediaSession === "function") {
            ariMediaService.closeMediaSession(linkedid, reason).catch(() => {});
        }
    } catch (_) {}

    if (!call) {
        const error = new Error("PBX call not found");
        error.status = 404;
        throw error;
    }

    const channels = [...call.channels].filter(Boolean);

    if (channels.length === 0) {
        const error = new Error("PBX call has no tracked channels to hang up");
        error.status = 409;
        throw error;
    }

    const results = [];

    for (const channel of channels) {
        try {
            results.push({
                channel,
                ok: true,
                response: await hangupChannel(channel, reason),
            });
        } catch (error) {
            results.push({
                channel,
                ok: false,
                error: error.message,
                status: error.response?.status,
            });
        }
    }

    return {
        linkedid,
        reason,
        channels: results,
    };
}

async function connectCallToExtension(linkedid, extension, context = env.pbxOriginateContext) {
    validateRequired({ linkedid, extension });
    ensureReady();
    const targetContext = context || env.pbxOriginateContext;
    console.log("[pbx:action] connect call to extension requested", {
        linkedid,
        extension,
        context: targetContext,
    });
    rememberAction(linkedid, "connect_extension_requested", {
        extension,
        context: targetContext,
    });

    const call = callsByLinkedId.get(linkedid);

    if (!call) {
        const error = new Error("PBX call not found");
        error.status = 404;
        throw error;
    }

    if (isFinalCallStatus(call.status)) {
        const primary = primaryCallChannel(call);
        if (call.answered && primary && !isCallPrimaryChannelHungUp(call)) {
            call.status = "ANSWER";
            call.result = "answered";
        } else {
            const error = new Error(`La llamada PBX ya no esta activa (${call.status}). Asterisk la cancelo/colgo antes de que EVA pudiera conectarla a la extension ${extension}.`);
            error.status = 409;
            rememberAction(linkedid, "connect_extension_rejected_final_status", {
                extension,
                status: call.status,
                result: call.result,
                channels: call.channels,
            });
            throw error;
        }
    }

    const existingExtensionChannels = channelsForExtension(call, extension);

    if (existingExtensionChannels.length > 0) {
        console.log("[pbx:action] call already dialing requested extension", {
            linkedid,
            extension,
            channels: existingExtensionChannels,
        });
        rememberAction(linkedid, "connect_extension_already_dialing", {
            extension,
            channels: existingExtensionChannels,
        });

        return {
            linkedid,
            extension,
            alreadyDialing: true,
            channels: existingExtensionChannels,
            message: "PBX call is already dialing the requested extension",
        };
    }

    const channel = primaryCallChannel(call);

    if (!channel) {
        const error = new Error("PBX call has no tracked channel to redirect");
        error.status = 409;
        throw error;
    }

    return redirectChannel(channel, {
        context: targetContext,
        extension,
        priority: env.pbxOriginatePriority,
    }).then((response) => {
        rememberAction(linkedid, "connect_extension_redirect_sent", {
            channel,
            extension,
            context: targetContext,
            response,
        });

        return {
            linkedid,
            channel,
            context: targetContext,
            extension,
            response,
        };
    });
}

async function redirectCallToContext(linkedid, target = {}) {
    const context = String(target.context || "").trim();
    const extension = String(target.extension || "").trim();
    const priority = Number(target.priority || 1) || 1;
    const actionPrefix = String(target.actionPrefix || "redirect_stasis").trim() || "redirect_stasis";
    const logLabel = String(target.logLabel || "ARI Stasis").trim() || "ARI Stasis";

    validateRequired({ linkedid, context, extension });
    ensureReady();

    console.log(`[pbx:action] redirect call to ${logLabel} requested`, {
        linkedid,
        context,
        extension,
        priority,
    });
    rememberAction(linkedid, `${actionPrefix}_requested`, {
        context,
        extension,
        priority,
    });

    const targetLinkedid = String(linkedid || "").trim();
    let call = callsByLinkedId.get(targetLinkedid);

    if (!call) {
        for (const c of callsByLinkedId.values()) {
            if (c.channels?.includes(targetLinkedid) || c.uniqueid === targetLinkedid) {
                call = c;
                break;
            }
        }
    }

    if (!call) {
        const error = new Error("PBX call not found: " + targetLinkedid);
        error.status = 404;
        throw error;
    }

    if (isFinalCallStatus(call.status)) {
        const primary = primaryCallChannel(call);
        if (primary && !isCallPrimaryChannelHungUp(call)) {
            console.log(`[pbx:action] call status was ${call.status} but primary channel ${primary} is still active; proceeding with ${logLabel} redirect`);
        } else {
            const error = new Error(`La llamada PBX ya no esta activa (${call.status}). No se puede redirigir a ${logLabel}.`);
            error.status = 409;
            rememberAction(linkedid, `${actionPrefix}_rejected_final_status`, {
                status: call.status,
                result: call.result,
                channels: call.channels,
            });
            throw error;
        }
    }

    const channel = primaryCallChannel(call);

    if (!channel) {
        const error = new Error(`PBX call has no tracked channel to redirect to ${logLabel}`);
        error.status = 409;
        throw error;
    }

    const response = await redirectChannel(channel, {
        context,
        extension,
        priority,
    });

    call.answered = true;
    call.status = "ANSWER";
    call.result = "answered";

    rememberAction(linkedid, `${actionPrefix}_sent`, {
        channel,
        context,
        extension,
        priority,
        response,
    });

    return {
        linkedid,
        channel,
        context,
        extension,
        priority,
        response,
    };
}

function redirectCallToStasis(linkedid) {
    return redirectCallToContext(linkedid, {
        context: env.ariStasisContext,
        extension: env.ariStasisExtension,
        priority: env.ariStasisPriority,
        actionPrefix: "redirect_stasis",
        logLabel: "ARI Stasis",
    });
}

function redirectCallToBridge(linkedid, bridgeToken, dialContext = env.sipBridgeDialContext) {
    return redirectCallToContext(linkedid, {
        context: dialContext || "ariana-sip-bridge",
        extension: bridgeToken,
        priority: 1,
        actionPrefix: "redirect_stasis",
        logLabel: "SIP Media Bridge",
    });
}

function primaryCallChannel(call) {
    if (!call) return "";

    const events = Array.isArray(call.events) ? call.events : [];
    const hungupChannels = new Set();
    const agentDestChannels = new Set();
    const queueCallerChannels = [];

    for (const ev of events) {
        const name = String(ev?.event || "").toLowerCase();
        const ch = String(ev?.channel || "").trim();
        const dest = String(ev?.destChannel || "").trim();

        if (name === "hangup" && ch) {
            hungupChannels.add(ch);
        }
        if ((name === "agentcalled" || name === "dialbegin") && dest) {
            agentDestChannels.add(dest);
        }
        if (name === "queuecallerjoin" && ch) {
            queueCallerChannels.push(ch);
        }
    }

    const isEligibleCaller = (ch) =>
        Boolean(ch) &&
        !ch.startsWith("UnicastRTP/") &&
        !isBridgeLegChannel(ch) &&
        classifyChannel(ch) !== "agent_leg" &&
        !agentDestChannels.has(ch);

    // 1. Live caller leg explicitly registered on QueueCallerJoin
    for (let i = queueCallerChannels.length - 1; i >= 0; i -= 1) {
        const ch = queueCallerChannels[i];
        if (isEligibleCaller(ch) && !hungupChannels.has(ch)) {
            return ch;
        }
    }

    // 2. Canonical primaryChannel tracked by callState when still live & eligible
    const stateCall = call.linkedid ? callState.getCall(call.linkedid) : null;
    if (
        stateCall?.primaryChannel &&
        isEligibleCaller(stateCall.primaryChannel) &&
        !hungupChannels.has(stateCall.primaryChannel)
    ) {
        return stateCall.primaryChannel;
    }

    const channels = Array.isArray(call.channels) ? call.channels : [];

    // 3. Live external non-local channel excluding agent dial destinations and bridge legs
    const liveExternal = channels.find(
        (ch) => !ch.startsWith("Local/") && isEligibleCaller(ch) && !hungupChannels.has(ch)
    );
    if (liveExternal) {
        return liveExternal;
    }

    // 4. Live eligible channel (e.g. Local/*@simulador-cola;2 or Local trunk)
    const liveEligible = channels.find((ch) => isEligibleCaller(ch) && !hungupChannels.has(ch));
    if (liveEligible) {
        return liveEligible;
    }

    // 5. Fallback for synthetic calls or tests without active channels
    const anyQueueJoin = queueCallerChannels[queueCallerChannels.length - 1];
    if (anyQueueJoin && isEligibleCaller(anyQueueJoin)) {
        return anyQueueJoin;
    }

    const anyExternal = channels.find((ch) => !ch.startsWith("Local/") && isEligibleCaller(ch));
    if (anyExternal) {
        return anyExternal;
    }

    return channels.find(isEligibleCaller) || channels[0] || "";
}

function isFinalCallStatus(status) {
    return ["BUSY", "NOANSWER", "CANCEL", "CHANUNAVAIL", "CONGESTION", "HANGUP"]
        .includes(String(status || "").toUpperCase());
}

function channelsForExtension(call, extension) {
    const channels = new Set();

    for (const channel of call.channels || []) {
        if (referencesExtension(channel, extension)) {
            channels.add(channel);
        }
    }

    for (const event of call.events || []) {
        if (referencesExtension(event.channel, extension)) {
            channels.add(event.channel);
        }

        if (referencesExtension(event.destChannel, extension)) {
            channels.add(event.destChannel);
        }
    }

    return [...channels].filter(Boolean);
}

function referencesExtension(value, extension) {
    const target = String(extension || "").trim();
    const text = String(value || "").trim();

    if (!target || !text) {
        return false;
    }

    const withoutTech = text.replace(/^(PJSIP|SIP|IAX2|DAHDI)\//i, "");

    return withoutTech === target ||
        withoutTech.startsWith(`${target}-`) ||
        withoutTech.startsWith(`${target}/`) ||
        withoutTech.startsWith(`${target}@`) ||
        withoutTech.includes(`:${target}@`);
}

function rememberAction(linkedid, action, details = {}) {
    if (!linkedid) {
        return;
    }

    if (!actionsByLinkedId.has(linkedid)) {
        actionsByLinkedId.set(linkedid, []);
    }

    const items = actionsByLinkedId.get(linkedid);
    items.push({
        time: new Date().toISOString(),
        action,
        details,
    });

    while (items.length > 80) {
        items.shift();
    }
}

function buildDiagnosis({
    call,
    hasAnswer,
    hasBridge,
    hangups,
    requestedConnect,
    alreadyDialing,
    redirectSent,
}) {
    if (hasBridge || hasAnswer || call.answered || call.bridged) {
        return {
            level: "media",
            message: "Asterisk reporto llamada contestada/puenteada. Si no hay audio, revisar RTP, NAT, codecs o direct media.",
            nextSteps: [
                "En Asterisk ejecutar: rtp set debug on",
                "Confirmar trafico RTP entre FXO/Asterisk y la extension",
                "Revisar direct_media=no, rtp_symmetric=yes, force_rport=yes, rewrite_contact=yes",
            ],
        };
    }

    if (alreadyDialing) {
        return {
            level: "signaling",
            message: "La llamada ya estaba timbrando en la extension solicitada, pero Asterisk no reporto ANSWER ni bridgeenter.",
            nextSteps: [
                "Contestar desde el telefono o Zoiper de esa extension",
                "Revisar si la extension esta registrada y realmente contesta la llamada",
                "En consola Asterisk buscar DialStatus ANSWER o BridgeEnter",
            ],
        };
    }

    if (redirectSent) {
        return {
            level: "signaling",
            message: "Ariana envio Redirect hacia la extension, pero Asterisk no reporto llamada contestada.",
            nextSteps: [
                "Revisar contexto/exten/prioridad usados en Redirect",
                "Confirmar que la extension existe y esta registrada",
                "Buscar en Asterisk errores de dialplan o PJSIP al redirigir",
            ],
        };
    }

    if (!requestedConnect) {
        return {
            level: "eva",
            message: "Ariana recibio eventos de llamada, pero no recibio la orden de EVA para conectar la extension.",
            nextSteps: [
                "Revisar URL/token TRUNCAL en EVA",
                "Revisar last_error en trunk_calls",
                "Confirmar que el boton Responder llama a /api/pbx/calls/{linkedid}/connect-extension",
            ],
        };
    }

    if (hangups.length > 0 || ["CANCEL", "HANGUP"].includes(String(call.status || "").toUpperCase())) {
        return {
            level: "pbx",
            message: "La llamada termino antes de quedar contestada.",
            nextSteps: [
                "Revisar ruta entrante de FreePBX/Asterisk",
                "Evitar que la troncal cuelgue antes de que el agente conteste",
                "Revisar hangup cause y logs del dialplan",
            ],
        };
    }

    return {
        level: "unknown",
        message: "No hay suficientes eventos para determinar la causa.",
        nextSteps: [
            "Repetir prueba con logs crudos activos",
            "Consultar este endpoint justo despues de presionar Responder",
        ],
    };
}

function notifyLaravel(event) {
    if (isSubChannelEvent(event)) {
        const eventName = String(event.event || "").toLowerCase();
        const dialStatus = String(event.dialStatus || "").toUpperCase();

        if (["hangup", "hanguprequest", "softhanguprequest"].includes(eventName) || (eventName === "dialend" && dialStatus !== "ANSWER")) {
            if (env.pbxLogLaravelCallbacks) {
                console.log("[pbx:laravel] subchannel non-terminal event skipped", {
                    linkedid: event.linkedid || null,
                    event: event.event || null,
                    channel: event.channel || null,
                    dialStatus: event.dialStatus || null,
                });
            }
            return;
        }
    }

    if (isRedirectCancelEvent(event)) {
        if (env.pbxLogLaravelCallbacks) {
            console.log("[pbx:laravel] redirect cancel event skipped", {
                linkedid: event.linkedid || null,
                event: event.event || null,
                channel: event.channel || null,
                destChannel: event.destChannel || null,
            });
        }
        return;
    }

    if (isQueueRedirectExitEvent(event)) {
        if (env.pbxLogLaravelCallbacks) {
            console.log("[pbx:laravel] queue redirect exit event skipped", {
                linkedid: event.linkedid || null,
                event: event.event || null,
                channel: event.channel || null,
            });
        }
        return;
    }

    if (isSecondaryRedirectLifecycleEvent(event)) {
        if (env.pbxLogLaravelCallbacks) {
            console.log("[pbx:laravel] secondary redirect event skipped", {
                linkedid: event.linkedid || null,
                event: event.event || null,
                channel: event.channel || null,
            });
        }
        return;
    }

    if (isExternalMediaLifecycleEvent(event)) {
        if (env.pbxLogLaravelCallbacks) {
            console.log("[pbx:laravel] external media event skipped", {
                linkedid: event.linkedid || null,
                event: event.event || null,
                channel: event.channel || null,
            });
        }
        return;
    }

    if (!env.laravelTrunkEventsEnabled) {
        if (env.pbxLogLaravelCallbacks) {
            console.log("[pbx:laravel] callback skipped because LARAVEL_TRUNK_EVENTS_ENABLED=false", {
                linkedid: event.linkedid || null,
                event: event.event || null,
            });
        }
        return;
    }

    const metadata = resolveEventMetadata(event);
    const callbackEvent = metadata
        ? {
            ...event,
            ...metadata,
        }
        : event;
    const summary = event.linkedid ? getCallByLinkedId(event.linkedid) : null;
    const callbackSummary = metadata
        ? {
            ...(summary || {}),
            ...metadata,
        }
        : summary;

    if (!metadata && !event.linkedid && !callbackSummary) {
        if (env.pbxLogLaravelCallbacks) {
            console.log("[pbx:laravel] unidentified event skipped", {
                event: event.event || null,
                channel: event.channel || null,
                destChannel: event.destChannel || null,
            });
        }

        return;
    }

    const payload = {
        ...(metadata || {}),
        event: callbackEvent,
        summary: callbackSummary,
        source: "ariana-asterisk-pbx",
    };

    if (env.pbxLogLaravelCallbacks) {
        console.log("[pbx:laravel] sending trunk event", {
            linkedid: event.linkedid || null,
            event: event.event || null,
            direction: metadata?.direction || null,
            outboundCallId: metadata?.outbound_call_id || null,
            url: `${env.laravelApiUrl.replace(/\/$/, "")}${env.laravelTrunkEventsPath}`,
            hasSummary: Boolean(callbackSummary),
        });
    }

    laravelService
        .sendTrunkCallEvent(payload)
        .then((response) => {
            if (env.pbxLogLaravelCallbacks) {
                console.log("[pbx:laravel] trunk event accepted", {
                    linkedid: event.linkedid || null,
                    event: event.event || null,
                    response,
                });
            }
        })
        .catch((error) => {
            console.error("[pbx] Laravel trunk event callback failed", {
                linkedid: event.linkedid || null,
                event: event.event || null,
                message: error.message,
                status: error.response?.status,
            });
    });
}

function notifyLaravelV2(event) {
    if (!event || !event.linkedid) {
        return;
    }

    const metadata = resolveEventMetadata(event);
    const isOutbound = Boolean(metadata && metadata.direction === "outbound");
    const decision = callState.processEvent(event, { isOutbound });

    if (!decision || !decision.call) {
        return;
    }

    if (decision.isTerminal) {
        auditLog.record({
            category: "call",
            type: decision.call.status,
            linkedid: decision.call.linkedid,
            queue: decision.call.queue,
            caller: decision.call.callerNumber,
            agentExtension: decision.call.answeredExtension || decision.call.targetExtension || null,
            outcome: decision.reason,
            summary: `Terminal ${decision.call.status} (${decision.call.primaryChannel || "no-channel"})`,
        });
    } else if (decision.emit) {
        auditLog.record({
            category: "call",
            type: decision.emitEventName,
            linkedid: decision.call.linkedid,
            queue: decision.call.queue,
            caller: decision.call.callerNumber,
            agentExtension: decision.call.answeredExtension || decision.call.targetExtension || null,
            outcome: decision.call.status,
            summary: decision.reason,
        });
    }

    if (!decision.emit || !env.laravelTrunkEventsEnabled) {
        return;
    }

    const stateCall = decision.call;
    const legacyCall = callsByLinkedId.get(event.linkedid);
    const mappedStatus =
        stateCall.status === "ENDED"
            ? "HANGUP"
            : stateCall.status === "ABANDONED"
                ? "ABANDONED"
                : stateCall.status === "ANSWERED"
                    ? "ANSWER"
                    : stateCall.status;

    const callbackEvent = {
        ...event,
        event: decision.emitEventName || event.event,
        timestamp: event.time,
        occurred_at: event.time,
        queue: event.queue || stateCall.queue || "",
    };

    const callbackSummary = {
        linkedid: stateCall.linkedid,
        firstEventTime: stateCall.firstEventAt,
        lastEventTime: stateCall.lastEventAt,
        queueJoinedAt: stateCall.queueJoinedAt,
        ringStartedAt: stateCall.ringStartedAt,
        answeredAt: stateCall.answeredAt,
        endedAt: stateCall.endedAt,
        from: (legacyCall && legacyCall.from) || stateCall.callerNumber || event.caller || "",
        to: (legacyCall && legacyCall.to) || stateCall.targetExtension || stateCall.queue || event.destination || "",
        callerName: (legacyCall && legacyCall.callerName) || stateCall.callerName || event.callerName || "",
        queue: stateCall.queue || "",
        status: mappedStatus,
        answered: Boolean(stateCall.answered),
        bridged: Boolean(stateCall.bridged),
        hangupCause: stateCall.hangupCause || "",
        hangupText: stateCall.hangupText || "",
        result: mappedStatus.toLowerCase(),
    };

    const payload = {
        ...(metadata || {}),
        linkedid: stateCall.linkedid,
        event_type: mappedStatus,
        is_terminal_event: Boolean(decision.isTerminal),
        occurred_at: event.time,
        event: callbackEvent,
        summary: callbackSummary,
        source: "ariana-asterisk-pbx",
    };

    if (env.pbxLogLaravelCallbacks) {
        console.log("[pbx:laravel:v2] enqueueing trunk event", {
            linkedid: stateCall.linkedid,
            event: callbackEvent.event,
            status: mappedStatus,
            dedupeKey: decision.dedupeKey,
            isTerminal: decision.isTerminal,
        });
    }

    laravelService
        .sendTrunkCallEvent(payload, {
            linkedid: stateCall.linkedid,
            dedupeKey: decision.dedupeKey,
        })
        .catch((error) => {
            console.error("[pbx:laravel:v2] failed to enqueue trunk event", {
                linkedid: stateCall.linkedid,
                event: callbackEvent.event,
                message: error.message,
            });
        });
}

function resolveEventMetadata(event) {
    for (const resolver of eventMetadataResolvers) {
        try {
            const metadata = resolver(event);

            if (metadata && typeof metadata === "object") {
                return metadata;
            }
        } catch (error) {
            console.warn("[pbx:event-metadata] resolver failed", {
                message: error.message,
                linkedid: event.linkedid || null,
                event: event.event || null,
            });
        }
    }

    return null;
}

function registerEventMetadataResolver(resolver) {
    if (typeof resolver !== "function") {
        throw new TypeError("PBX event metadata resolver must be a function");
    }

    eventMetadataResolvers.add(resolver);

    return () => eventMetadataResolvers.delete(resolver);
}

function onManagerEvent(listener) {
    lifecycleEvents.on("manager-event", listener);

    return () => lifecycleEvents.off("manager-event", listener);
}

function notifyRedirectStasisEarlyEnd(event) {
    const decision = redirectStasisEarlyEndDecision(event);

    if (!decision.shouldNotify) {
        return;
    }

    rememberAction(event.linkedid, "redirect_stasis_early_end_notified", {
        event: event.event,
        channel: event.channel,
        destChannel: event.destChannel,
        dialStatus: event.dialStatus,
        reason: decision.reason,
    });

    console.log("[pbx:lifecycle] redirect stasis early end detected", {
        linkedid: event.linkedid,
        event: event.event,
        channel: event.channel,
        destChannel: event.destChannel,
        dialStatus: event.dialStatus,
        reason: decision.reason,
    });

    lifecycleEvents.emit("redirect-stasis-early-end", {
        linkedid: event.linkedid,
        event: { ...event },
        reason: decision.reason,
        call: getCallByLinkedId(event.linkedid),
    });

    hangupCall(event.linkedid, decision.reason)
        .catch((error) => {
            console.warn("[pbx:lifecycle] redirect stasis early hangup failed", {
                linkedid: event.linkedid,
                reason: decision.reason,
                message: error.message,
                status: error.status || error.response?.status || null,
            });
        });
}

function redirectStasisEarlyEndDecision(event) {
    if (!event.linkedid) {
        return { shouldNotify: false };
    }

    const call = callsByLinkedId.get(event.linkedid);

    if (!call) {
        return { shouldNotify: false };
    }

    const actions = actionsByLinkedId.get(event.linkedid) || [];
    const redirectRequested = actions.some((item) =>
        item.action === "redirect_stasis_requested" ||
        item.action === "redirect_stasis_sent"
    );
    const alreadyNotified = actions.some((item) => item.action === "redirect_stasis_early_end_notified");

    if (!redirectRequested || alreadyNotified) {
        return { shouldNotify: false };
    }

    if (call.answered || call.bridged || call.wasBridged || call.status === "ANSWER" || call.result === "answered") {
        return { shouldNotify: false };
    }

    if (isPrimaryRedirectLifecycleEnd(event, call)) {
        return {
            shouldNotify: true,
            reason: "redirect_primary_channel_ended",
        };
    }

    return { shouldNotify: false };
}

function isRedirectCancelEvent(event) {
    const actions = actionsByLinkedId.get(event.linkedid) || [];

    return String(event.event || "").toLowerCase() === "dialend" &&
        String(event.dialStatus || "").toUpperCase() === "CANCEL" &&
        actions.some((item) => item.action === "redirect_stasis_requested" || item.action === "redirect_stasis_sent");
}

function isQueueRedirectExitEvent(event) {
    const eventName = String(event.event || "").toLowerCase();
    if (!["queuecallerabandon", "queuecallerleave"].includes(eventName) || !event.linkedid) {
        return false;
    }

    const actions = actionsByLinkedId.get(event.linkedid) || [];
    const isRedirected = actions.some((item) =>
        item.action === "redirect_stasis_requested" || item.action === "redirect_stasis_sent"
    );

    const call = callsByLinkedId.get(event.linkedid);
    const isAnsweredOrBridged = Boolean(call?.answered || call?.bridged || call?.wasBridged || call?.status === "ANSWER");

    return isRedirected || isAnsweredOrBridged;
}

function isSecondaryRedirectLifecycleEvent(event) {
    const eventName = String(event.event || "").toLowerCase();

    if (!["hangup", "bridgeleave"].includes(eventName) || !event.linkedid) {
        return false;
    }

    const call = callsByLinkedId.get(event.linkedid);

    if (!call || !call.events.some((item) => item.event === "dialend" && item.dialStatus === "CANCEL")) {
        return false;
    }

    const primary = primaryCallChannel(call);
    const channel = String(event.channel || "");

    return Boolean(primary && channel && channel !== primary);
}

function isExternalMediaLifecycleEvent(event) {
    const channels = [event.channel, event.destChannel]
        .map((value) => String(value || ""));

    return channels.some((channel) => channel.startsWith("UnicastRTP/"));
}

function isCallPrimaryChannelHungUp(call) {
    const primary = primaryCallChannel(call);
    if (!primary) {
        return false;
    }
    return (call.events || []).some((event) =>
        event.event === "hangup" && String(event.channel || "") === primary
    );
}

function isSubChannelEvent(event) {
    const channel = String(event?.channel || "");
    const destChannel = String(event?.destChannel || "");
    return (
        channel.startsWith("Local/") ||
        channel.startsWith("UnicastRTP/") ||
        destChannel.startsWith("Local/") ||
        destChannel.startsWith("UnicastRTP/")
    );
}

function isNonTerminalHangupEvent(event, call) {
    if (!call || !event) {
        return false;
    }

    const channel = String(event.channel || "");
    const kind = classifyChannel(channel, event.context);
    const primary = primaryCallChannel(call);

    if (kind === "internal_media" || channel.startsWith("UnicastRTP/")) {
        return true;
    }

    if (kind === "agent_leg" || kind === "bridge_leg") {
        return true;
    }

    if (channel.startsWith("Local/") && (!primary || channel !== primary)) {
        return true;
    }

    if (isExternalMediaLifecycleEvent(event) || isSecondaryRedirectLifecycleEvent(event)) {
        return true;
    }

    const actions = actionsByLinkedId.get(event.linkedid) || [];
    const redirectSent = actions.some((item) => item.action === "connect_extension_redirect_sent");

    if (redirectSent && primary && channel && channel !== primary) {
        return true;
    }

    if (primary && channel && channel !== primary && (call.answered || call.bridged)) {
        return true;
    }

    return false;
}

function isPrimaryRedirectLifecycleEnd(event, call) {
    const eventName = String(event.event || "").toLowerCase();

    if (!["hangup", "bridgeleave"].includes(eventName)) {
        return false;
    }

    const primary = primaryCallChannel(call);
    const channel = String(event.channel || "");

    return Boolean(primary && channel && channel === primary);
}

function onRedirectStasisEarlyEnd(listener) {
    lifecycleEvents.on("redirect-stasis-early-end", listener);

    return () => lifecycleEvents.off("redirect-stasis-early-end", listener);
}

async function originateExtension(fromExtension, toExtension) {
    validateRequired({ fromExtension, toExtension });
    console.log("[pbx:action] originate extension requested", {
        fromExtension,
        toExtension,
    });

    return originate({
        Channel: `PJSIP/${fromExtension}`,
        Context: env.pbxOriginateContext,
        Exten: toExtension,
        Priority: env.pbxOriginatePriority,
        CallerID: callerId(toExtension),
        Timeout: env.pbxOriginateTimeoutMs,
        Async: true,
    });
}

async function originateOutboundApplication({
    actionId,
    phoneNumber,
    fromNumber,
    application = "Stasis",
    applicationData = "",
    variables = {},
}) {
    validateRequired({ actionId, phoneNumber, application });
    validateDialValue("phoneNumber", phoneNumber, /^\+?[0-9]{3,20}$/);
    validateDialValue("context", env.pbxOriginateContext, /^[A-Za-z0-9_.-]+$/);
    validateDialValue("application", application, /^[A-Za-z0-9_.-]+$/);
    validateManagerValue("applicationData", applicationData);

    const safeVariables = Object.fromEntries(
        Object.entries(variables).map(([name, value]) => {
            validateDialValue("variable name", name, /^[A-Za-z_][A-Za-z0-9_]*$/);
            validateManagerValue(`variable ${name}`, value);

            return [name, String(value)];
        })
    );
    const channel = `Local/${phoneNumber}@${env.pbxOriginateContext}/n`;

    console.log("[pbx:action] originate outbound application requested", {
        actionId,
        phoneNumber,
        fromNumber,
        channel,
        application,
    });

    const response = await originate({
        actionid: actionId,
        Channel: channel,
        Application: application,
        Data: applicationData,
        Variable: safeVariables,
        CallerID: callerId(phoneNumber, fromNumber),
        Timeout: env.pbxOriginateTimeoutMs,
        Async: true,
    });

    return {
        actionId,
        channel,
        context: env.pbxOriginateContext,
        response,
    };
}

async function originateExternal(fromExtension, phoneNumber) {
    validateRequired({ fromExtension, phoneNumber });
    console.log("[pbx:action] originate external requested", {
        fromExtension,
        phoneNumber,
    });

    return originate({
        Channel: `PJSIP/${fromExtension}`,
        Context: env.pbxOriginateContext,
        Exten: phoneNumber,
        Priority: env.pbxOriginatePriority,
        CallerID: callerId(phoneNumber, fromExtension),
        Timeout: env.pbxOriginateTimeoutMs,
        Async: true,
    });
}

async function originateDirect(phoneNumber, trunkEndpoint = env.pbxDirectTrunkEndpoint) {
    validateRequired({ phoneNumber, trunkEndpoint });
    console.log("[pbx:action] originate direct requested", {
        phoneNumber,
        trunkEndpoint,
    });

    return originate({
        Channel: `PJSIP/${phoneNumber}@${trunkEndpoint}`,
        Application: "Playback",
        Data: "demo-congrats",
        CallerID: callerId(phoneNumber),
        Timeout: env.pbxOriginateTimeoutMs,
        Async: true,
    });
}

function callerId(target, fromNumber = "") {
    const prefix = env.pbxCallerIdPrefix || "Ariana";
    const name = `${prefix} -> ${target}`;
    const rawNumber = String(fromNumber || env.pbxDefaultCallerIdNumber || "").trim();
    const cleanNumber = rawNumber.replace(/[^0-9+*#]/g, "");

    return cleanNumber ? `"${name}" <${cleanNumber}>` : name;
}

function validateRequired(fields) {
    for (const [field, value] of Object.entries(fields)) {
        if (!value) {
            const error = new Error(`${field} is required`);
            error.status = 422;
            throw error;
        }
    }
}

function validateDialValue(field, value, pattern) {
    if (!pattern.test(String(value || ""))) {
        const error = new Error(`${field} has an invalid format`);
        error.status = 422;
        throw error;
    }
}

function validateManagerValue(field, value) {
    if (/[\r\n]/.test(String(value || ""))) {
        const error = new Error(`${field} contains invalid control characters`);
        error.status = 422;
        throw error;
    }
}

function originate(action) {
    ensureReady();
    console.log("[pbx:ami-action] Originate", action);

    return runAmiAction({
        Action: "Originate",
        ...action,
    });
}

function hangupChannel(channel, reason) {
    console.log("[pbx:ami-action] Hangup", { channel, reason });

    return runAmiAction({
        Action: "Hangup",
        Channel: channel,
        Cause: env.pbxHangupCause,
        Reason: reason,
    });
}

function hangupChannelByName(channel, reason = "outbound_cancelled") {
    validateRequired({ channel });
    validateManagerValue("channel", channel);

    return hangupChannel(channel, reason);
}

function redirectChannel(channel, target) {
    console.log("[pbx:ami-action] Redirect", { channel, ...target });

    return runAmiAction({
        Action: "Redirect",
        Channel: channel,
        Context: target.context,
        Exten: target.extension,
        Priority: target.priority,
    });
}

function enableAmiEvents() {
    if (!env.pbxAmiEventMask) {
        return;
    }

    const action = {
        Action: "Events",
        EventMask: env.pbxAmiEventMask,
    };

    console.log("[pbx:ami-action] Events", action);

    runAmiAction(action)
        .then((response) => {
            console.log("[pbx:ami-action] Events response", response);
        })
        .catch((error) => {
            console.error("[pbx:ami-action] Events failed", {
                message: error.message,
            });
        });
}

function runAmiAction(action) {
    ensureAmiInstance();

    return new Promise((resolve, reject) => {
        ami.action(action, (error, response) => {
            if (error) {
                return reject(error);
            }

            return resolve(response);
        });
    });
}

function logTrackedEvent(event) {
    if (!env.pbxLogTrackedEvents) {
        return;
    }

    console.log("[pbx:event:tracked]", {
        event: event.event,
        linkedid: event.linkedid,
        caller: event.caller,
        destination: event.destination,
        channel: event.channel,
        destChannel: event.destChannel,
        dialStatus: event.dialStatus,
        cause: event.cause,
        causeTxt: event.causeTxt,
    });
}

function logCallSummary(linkedid) {
    if (!env.pbxLogTrackedEvents || !linkedid) {
        return;
    }

    const call = callsByLinkedId.get(linkedid);

    if (!call) {
        return;
    }

    console.log("[pbx:call:summary]", {
        linkedid: call.linkedid,
        from: call.from,
        to: call.to,
        status: call.status,
        answered: call.answered,
        bridged: call.bridged,
        result: call.result,
        channels: call.channels,
        totalEvents: call.events.length,
    });
}

function ensureReady() {
    if (!env.pbxAmiEnabled) {
        const error = new Error("PBX AMI is disabled");
        error.status = 409;
        throw error;
    }

    if (!started) {
        start();
    }

    if (!ami) {
        const error = new Error(lastAmiError || "PBX AMI is not available");
        error.status = 503;
        throw error;
    }
}

function ensureAmiInstance() {
    if (!ami) {
        const error = new Error(lastAmiError || "PBX AMI is not available");
        error.status = 503;
        throw error;
    }
}

async function pauseQueueMember(arg1, arg2, arg3, arg4) {
    let extension, paused, reason, queue, force;
    if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1)) {
        extension = arg1.extension;
        paused = arg1.paused ?? true;
        reason = arg1.reason || "";
        queue = arg1.queue || "";
        force = Boolean(arg1.force);
    } else {
        extension = arg1;
        paused = arg2 ?? true;
        reason = arg3 || "";
        queue = arg4 || "";
        force = false;
    }

    validateRequired({ extension });
    ensureReady();

    const cleanExt = extractExtensionNumber(extension) || String(extension).trim();
    const isPaused = Boolean(paused);
    const pauseReason = String(reason || (isPaused ? "paused_by_eva" : "available")).trim();
    const targetQueue = String(queue || "650").trim();

    const result = await queuePresence.setMemberPaused({
        queue: targetQueue,
        extension: cleanExt,
        paused: isPaused,
        reason: pauseReason,
        force,
        runAmiAction,
        fetchQueueStatus: (q) => getQueueStatus(q, { timeoutMs: 1200 }),
    });

    if (!result.skipped) {
        console.log("[pbx:queue] queue pause applied", {
            extension: cleanExt,
            paused: isPaused,
            reason: pauseReason,
            queue: targetQueue,
            ok: Boolean(result.ok),
            interface: result.interface || null,
        });
    }

    const results = result.ok
        ? [{ interface: result.interface || null, ok: true, skipped: Boolean(result.skipped), response: result.response }]
        : (result.attempts || []).map((a) => ({ interface: a.interface, ok: false, error: a.error }));

    if (!result.skipped && result.ok) {
        try {
            await runAmiAction({
                Action: "DBPut",
                Family: "eva_presence",
                Key: cleanExt,
                Val: isPaused ? "0" : "1",
            });
        } catch (dbErr) {
            console.warn("[pbx:queue] DBPut eva_presence failed", {
                extension: cleanExt,
                error: dbErr.message,
            });
        }
    }

    return {
        extension: cleanExt,
        paused: isPaused,
        reason: pauseReason,
        queue: queue || "all",
        skipped: Boolean(result.skipped),
        results,
    };
}

let activeExtensionChecker = null;

function registerActiveExtensionChecker(fn) {
    if (typeof fn === "function") {
        activeExtensionChecker = fn;
    }
}

const TERMINAL_CALL_STATES = new Set(["ENDED", "ABANDONED", "CANCELLED", "NOANSWER", "BUSY", "FAILED"]);

function isExtensionBusyLocally(extension) {
    const clean = extractExtensionNumber(extension);
    if (!clean) return false;

    if (typeof activeExtensionChecker === "function") {
        try {
            if (activeExtensionChecker(clean)) {
                return true;
            }
        } catch (_) {}
    }

    for (const call of callState.getAllCalls()) {
        if (!call || TERMINAL_CALL_STATES.has(String(call.status || "").toUpperCase())) {
            continue;
        }
        if (call.status !== "ANSWERED" && !call.answered) {
            continue;
        }
        const answeredExt = extractExtensionNumber(call.answeredExtension);
        if (answeredExt && answeredExt === clean) {
            return true;
        }
    }

    return false;
}

async function syncQueuePresence({ online_extensions = [], all_extensions = [], queue = "650", force = false }) {
    ensureReady();

    const cleanAllInput = (Array.isArray(all_extensions) ? all_extensions : [])
        .map((ext) => extractExtensionNumber(ext))
        .filter(Boolean);
    const resolvedAll = cleanAllInput.length > 0 ? cleanAllInput : ["801", "802", "803", "804"];

    const summary = await queuePresence.syncDelta({
        queue,
        onlineExtensions: online_extensions,
        allExtensions: resolvedAll,
        force: Boolean(force),
        isExtensionBusy: isExtensionBusyLocally,
        runAmiAction,
        fetchQueueStatus: (targetQueue) => getQueueStatus(targetQueue),
    });

    if (summary.changedCount > 0) {
        auditLog.record({
            category: "queue",
            type: "presence_delta",
            queue: summary.queue,
            outcome: "synced",
            summary: `Updated ${summary.changedCount} members, skipped ${summary.skippedCount} unchanged`,
        });
    }

    return summary;
}

function describeMemberDeviceStatus(statusCode) {
    const code = Number(statusCode);
    const map = {
        0: "UNKNOWN",
        1: "NOT_INUSE",
        2: "INUSE",
        3: "BUSY",
        4: "INVALID",
        5: "UNAVAILABLE",
        6: "RINGING",
        7: "RINGINUSE",
        8: "ONHOLD",
    };

    return map[code] || String(statusCode ?? "UNKNOWN");
}

function parseCommandOutputText(response) {
    if (!response) return "";
    if (typeof response === "string") return response;
    if (Array.isArray(response)) return response.join(" ");
    const candidate = response.output || response.content || response.data || response.response || "";
    if (Array.isArray(candidate)) return candidate.join(" ");
    return String(candidate || "");
}

async function probeAmiAsteriskVersion() {
    if (!ami || !connected) {
        return null;
    }

    let rawCandidate = "";
    try {
        const coreSettings = await runAmiAction({ Action: "CoreSettings" });
        rawCandidate = String(
            coreSettings?.asteriskversion ||
                coreSettings?.AsteriskVersion ||
                coreSettings?.coreversion ||
                ""
        ).trim();
    } catch (_err) {
        rawCandidate = "";
    }

    if (!rawCandidate) {
        try {
            const cmdRes = await runAmiAction({
                Action: "Command",
                Command: "core show version",
            });
            rawCandidate = parseCommandOutputText(cmdRes).trim();
        } catch (_err) {
            rawCandidate = "";
        }
    }

    if (!rawCandidate) {
        return null;
    }

    const parsed = parseAsteriskVersion(rawCandidate);
    if (parsed.detected) {
        amiAsteriskRawVersion = parsed.raw;
        amiAsteriskDetectedAt = new Date().toISOString();
        console.log("[pbx] Asterisk version detected via AMI", {
            version: parsed.parsedVersion,
            raw: parsed.raw,
        });
    }

    return parsed;
}

function collectQueueStatusFromAmi(amiClient, queue = "", timeoutMs = 2500) {
    const cleanQueue = String(queue || "").trim();
    const actionId = `qs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const expectedActionIds = new Set([actionId]);
    // asterisk-manager reads lowercase `action.actionid` and returns the final sent ActionID
    const action = {
        Action: "QueueStatus",
        actionid: actionId,
        ...(cleanQueue ? { Queue: cleanQueue } : {}),
    };

    return new Promise((resolve, reject) => {
        const params = [];
        const members = [];
        const entries = [];
        const events = [];
        let settled = false;
        let timer = null;
        let actionAck = null;

        const finish = (timedOut = false) => {
            if (settled) return;
            settled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (typeof amiClient.removeListener === "function") {
                amiClient.removeListener("managerevent", onManagerEvent);
            } else if (typeof amiClient.off === "function") {
                amiClient.off("managerevent", onManagerEvent);
            }

            const snapshot = {
                ok: true,
                queue: cleanQueue || null,
                collectedAt: new Date().toISOString(),
                timedOut,
                response: actionAck,
                params,
                members,
                entries,
                events,
            };
            resolve(snapshot);
        };

        const onManagerEvent = (rawEv = {}) => {
            const evActionId = String(rawEv.actionid || rawEv.ActionID || "").trim();
            if (!evActionId || !expectedActionIds.has(evActionId)) {
                return;
            }

            const evName = normalizeEventName(rawEv);
            const evQueue = String(rawEv.queue || rawEv.Queue || cleanQueue || "").trim();

            if (evName === "queueparams") {
                const paramItem = {
                    queue: evQueue,
                    max: Number(rawEv.max ?? rawEv.Max ?? 0),
                    calls: Number(rawEv.calls ?? rawEv.Calls ?? 0),
                    holdTime: Number(rawEv.holdtime ?? rawEv.Holdtime ?? rawEv.HoldTime ?? 0),
                    talkTime: Number(rawEv.talktime ?? rawEv.TalkTime ?? 0),
                    completed: Number(rawEv.completed ?? rawEv.Completed ?? 0),
                    abandoned: Number(rawEv.abandoned ?? rawEv.Abandoned ?? 0),
                    serviceLevel: Number(rawEv.servicelevel ?? rawEv.ServiceLevel ?? 0),
                    serviceLevelPerf: Number(rawEv.servicelevelperf ?? rawEv.ServicelevelPerf ?? 0),
                    strategy: String(rawEv.strategy || rawEv.Strategy || "").trim(),
                };
                params.push(paramItem);
                events.push({ Event: "QueueParams", Queue: evQueue, ...paramItem });
                return;
            }

            if (evName === "queuemember") {
                const iface = String(
                    rawEv.location || rawEv.Location || rawEv.interface || rawEv.Interface || ""
                ).trim();
                const stateIface = String(rawEv.stateinterface || rawEv.StateInterface || iface).trim();
                const statusCode = Number(rawEv.status ?? rawEv.Status ?? 0);
                const paused = ["1", "true", "yes"].includes(
                    String(rawEv.paused ?? rawEv.Paused ?? "0").trim().toLowerCase()
                );
                const inCall = ["1", "true", "yes"].includes(
                    String(rawEv.incall ?? rawEv.InCall ?? "0").trim().toLowerCase()
                );
                const memberName = String(rawEv.name || rawEv.Name || iface).trim();
                const memberItem = {
                    queue: evQueue,
                    name: memberName,
                    extension: extractExtensionNumber(iface || stateIface || memberName),
                    interface: iface,
                    stateInterface: stateIface,
                    membership: String(rawEv.membership || rawEv.Membership || "").trim(),
                    penalty: Number(rawEv.penalty ?? rawEv.Penalty ?? 0),
                    paused,
                    pausedReason: String(rawEv.pausedreason || rawEv.PausedReason || "").trim(),
                    status: Number.isFinite(statusCode) ? statusCode : 0,
                    statusLabel: describeMemberDeviceStatus(statusCode),
                    inCall,
                    callsTaken: Number(rawEv.callstaken ?? rawEv.CallsTaken ?? 0),
                    lastCall: Number(rawEv.lastcall ?? rawEv.LastCall ?? 0),
                };
                members.push(memberItem);
                events.push({
                    Event: "QueueMember",
                    Queue: evQueue,
                    Name: memberItem.name,
                    Interface: iface,
                    Location: iface,
                    StateInterface: stateIface,
                    Membership: memberItem.membership,
                    Paused: paused ? "1" : "0",
                    PausedReason: memberItem.pausedReason,
                    Status: String(memberItem.status),
                    InCall: inCall ? "1" : "0",
                    CallsTaken: String(memberItem.callsTaken),
                    LastCall: String(memberItem.lastCall),
                });
                return;
            }

            if (evName === "queueentry") {
                const entryItem = {
                    queue: evQueue,
                    position: Number(rawEv.position ?? rawEv.Position ?? 0),
                    channel: String(rawEv.channel || rawEv.Channel || "").trim(),
                    uniqueid: String(rawEv.uniqueid || rawEv.Uniqueid || "").trim(),
                    callerIdNum: String(rawEv.calleridnum || rawEv.CallerIDNum || "").trim(),
                    callerIdName: String(rawEv.calleridname || rawEv.CallerIDName || "").trim(),
                    connectedLineNum: String(rawEv.connectedlinenum || rawEv.ConnectedLineNum || "").trim(),
                    waitSeconds: Number(rawEv.wait ?? rawEv.Wait ?? 0),
                };
                entries.push(entryItem);
                events.push({ Event: "QueueEntry", Queue: evQueue, ...entryItem });
                return;
            }

            if (evName === "queuestatuscomplete") {
                events.push({ Event: "QueueStatusComplete", Queue: evQueue });
                finish(false);
            }
        };

        amiClient.on("managerevent", onManagerEvent);

        timer = setTimeout(() => {
            finish(true);
        }, Math.max(200, Number(timeoutMs) || 2500));

        const sentId = amiClient.action(action, (error, response) => {
            if (error) {
                if (!settled) {
                    settled = true;
                    if (timer) {
                        clearTimeout(timer);
                        timer = null;
                    }
                    if (typeof amiClient.removeListener === "function") {
                        amiClient.removeListener("managerevent", onManagerEvent);
                    } else if (typeof amiClient.off === "function") {
                        amiClient.off("managerevent", onManagerEvent);
                    }
                    reject(error);
                }
                return;
            }
            if (response && (response.actionid || response.ActionID)) {
                expectedActionIds.add(String(response.actionid || response.ActionID).trim());
            }
            actionAck = response;
        });

        if (sentId !== undefined && sentId !== null && String(sentId).trim() !== "") {
            expectedActionIds.add(String(sentId).trim());
        }
    });
}

async function getQueueStatus(queue = "", options = {}) {
    ensureReady();
    const snapshot = await collectQueueStatusFromAmi(ami, queue, options.timeoutMs || 2500);
    lastQueueStatusSnapshot = snapshot;
    return snapshot;
}

function getCachedQueueSnapshot() {
    return lastQueueStatusSnapshot;
}

module.exports = {
    start,
    stop,
    restart,
    getStatus,
    getCallEvents,
    getCallsSummary,
    getCallByLinkedId,
    getCallDiagnostics,
    getAmiStatus,
    hangupCall,
    connectCallToExtension,
    redirectCallToStasis,
    redirectCallToBridge,
    onRedirectStasisEarlyEnd,
    onManagerEvent,
    registerEventMetadataResolver,
    originateExtension,
    originateExternal,
    originateDirect,
    originateOutboundApplication,
    hangupChannelByName,
    pauseQueueMember,
    syncQueuePresence,
    registerActiveExtensionChecker,
    isExtensionBusyLocally,
    getQueueStatus,
    getCachedQueueSnapshot,
    probeAmiAsteriskVersion,
    extractExtensionNumber,
    __test: {
        updateCallSummary,
        collectQueueStatusFromAmi,
        primaryCallChannel,
        setAmiAsteriskVersionForTest(raw) {
            amiAsteriskRawVersion = raw || null;
            amiAsteriskDetectedAt = raw ? new Date().toISOString() : null;
        },
        resetCallTracking() {
            callEvents.length = 0;
            callsByLinkedId.clear();
            rawEventsByLinkedId.clear();
            actionsByLinkedId.clear();
        },
    },
};
