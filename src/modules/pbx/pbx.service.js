const AsteriskManager = require("asterisk-manager");
const EventEmitter = require("events");
const env = require("../../config/env");
const laravelService = require("../laravel/laravel.service");

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

    return getStatus();
}

function stop() {
    if (ami && typeof ami.disconnect === "function") {
        ami.disconnect();
    }

    ami = null;
    started = false;
    connected = false;
}

function extractExtensionNumber(value) {
    if (!value) {
        return "";
    }

    const text = String(value).trim();
    const match = text.match(/(?:Local\/|PJSIP\/|SIP\/)?(\d{3,4})(?:@|\b)/i);

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
    let agentExtension = extractExtensionNumber(agentCalledRaw);
    if (!agentExtension && (event.destchannel || event.DestChannel)) {
        agentExtension = extractExtensionNumber(event.destchannel || event.DestChannel);
    }
    const destCandidate = event.destination || event.Destination || "";
    if (!agentExtension && destCandidate && String(destCandidate) !== queueName) {
        agentExtension = extractExtensionNumber(destCandidate);
    }
    const extenCandidate = event.exten || event.Exten || "";
    if (!agentExtension && extenCandidate && String(extenCandidate) !== queueName) {
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
    notifyLaravel(normalized);
    lifecycleEvents.emit("manager-event", normalized);
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
            call.to = call.to || event.destination || "";
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
    return {
        enabled: env.pbxAmiEnabled,
        started,
        connected,
        host: env.pbxAmiHost,
        port: env.pbxAmiPort,
        username: env.pbxAmiUsername,
        outboundEnabled: env.trunkOutboundEnabled,
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

async function redirectCallToStasis(linkedid) {
    validateRequired({ linkedid });
    ensureReady();

    console.log("[pbx:action] redirect call to ARI Stasis requested", {
        linkedid,
        context: env.ariStasisContext,
        extension: env.ariStasisExtension,
        priority: env.ariStasisPriority,
    });
    rememberAction(linkedid, "redirect_stasis_requested", {
        context: env.ariStasisContext,
        extension: env.ariStasisExtension,
        priority: env.ariStasisPriority,
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
            console.log("[pbx:action] call status was " + call.status + " but primary channel " + primary + " is still active; proceeding with Stasis redirect");
        } else {
            const error = new Error(`La llamada PBX ya no esta activa (${call.status}). No se puede redirigir a ARI/Stasis.`);
            error.status = 409;
            rememberAction(linkedid, "redirect_stasis_rejected_final_status", {
                status: call.status,
                result: call.result,
                channels: call.channels,
            });
            throw error;
        }
    }

    const channel = primaryCallChannel(call);

    if (!channel) {
        const error = new Error("PBX call has no tracked channel to redirect to ARI/Stasis");
        error.status = 409;
        throw error;
    }

    const response = await redirectChannel(channel, {
        context: env.ariStasisContext,
        extension: env.ariStasisExtension,
        priority: env.ariStasisPriority,
    });

    call.answered = true;
    call.status = "ANSWER";
    call.result = "answered";

    rememberAction(linkedid, "redirect_stasis_sent", {
        channel,
        context: env.ariStasisContext,
        extension: env.ariStasisExtension,
        priority: env.ariStasisPriority,
        response,
    });

    return {
        linkedid,
        channel,
        context: env.ariStasisContext,
        extension: env.ariStasisExtension,
        priority: env.ariStasisPriority,
        response,
    };
}

function primaryCallChannel(call) {
    if (!call) return "";

    // 1. External non-local channel (e.g. PJSIP/..., SIP/..., DAHDI/...)
    const external = (call.channels || []).find(
        (ch) => ch && !ch.startsWith("Local/") && !ch.startsWith("UnicastRTP/")
    );
    if (external) {
        return external;
    }

    // 2. Non-local dialbegin channel
    const nonLocalDialBegin = [...call.events]
        .reverse()
        .find((event) => event.event === "dialbegin" && event.channel && !event.channel.startsWith("Local/"));
    if (nonLocalDialBegin?.channel) {
        return nonLocalDialBegin.channel;
    }

    // 3. Fallback
    const dialBegin = [...call.events]
        .reverse()
        .find((event) => event.event === "dialbegin" && event.channel);

    return dialBegin?.channel || call.channels[0] || "";
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
    if (channel.startsWith("Local/") || channel.startsWith("UnicastRTP/")) {
        return true;
    }

    if (isExternalMediaLifecycleEvent(event) || isSecondaryRedirectLifecycleEvent(event)) {
        return true;
    }

    const actions = actionsByLinkedId.get(event.linkedid) || [];
    const redirectSent = actions.some((item) => item.action === "connect_extension_redirect_sent");
    const primary = primaryCallChannel(call);

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
    let extension, paused, reason, queue;
    if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1)) {
        extension = arg1.extension;
        paused = arg1.paused ?? true;
        reason = arg1.reason || "";
        queue = arg1.queue || "";
    } else {
        extension = arg1;
        paused = arg2 ?? true;
        reason = arg3 || "";
        queue = arg4 || "";
    }

    validateRequired({ extension });
    ensureReady();

    const cleanExt = extractExtensionNumber(extension) || String(extension).trim();
    const isPaused = Boolean(paused);
    const pauseFlag = isPaused ? "1" : "0";
    const pauseReason = String(reason || (isPaused ? "paused_by_eva" : "available")).trim();

    console.log("[pbx:queue] queue pause requested", {
        extension: cleanExt,
        paused: isPaused,
        reason: pauseReason,
        queue: queue || "all",
    });

    const candidates = [
        `Local/${cleanExt}@from-queue/n`,
        `Local/${cleanExt}@from-queue`,
        `Local/${cleanExt}@from-internal/n`,
        cleanExt,
        `PJSIP/${cleanExt}`,
    ];

    const results = [];
    for (const iface of candidates) {
        try {
            const action = {
                Action: "QueuePause",
                Interface: iface,
                Paused: pauseFlag,
                Reason: pauseReason,
            };
            if (queue) {
                action.Queue = String(queue).trim();
            }
            const response = await runAmiAction(action);
            results.push({ interface: iface, ok: true, response });
        } catch (err) {
            results.push({ interface: iface, ok: false, error: err.message });
        }
    }

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

    return {
        extension: cleanExt,
        paused: isPaused,
        reason: pauseReason,
        queue: queue || "all",
        results,
    };
}

async function syncQueuePresence({ online_extensions = [], all_extensions = [], queue = "650" }) {
    ensureReady();

    const cleanOnline = (Array.isArray(online_extensions) ? online_extensions : [])
        .map((ext) => extractExtensionNumber(ext))
        .filter(Boolean);

    let cleanAll = (Array.isArray(all_extensions) ? all_extensions : [])
        .map((ext) => extractExtensionNumber(ext))
        .filter(Boolean);

    if (cleanAll.length === 0) {
        cleanAll = ["801", "802", "803", "804"];
    }

    for (const onExt of cleanOnline) {
        if (!cleanAll.includes(onExt)) {
            cleanAll.push(onExt);
        }
    }

    console.log("[pbx:queue] syncing queue presence", {
        queue,
        online: cleanOnline,
        all: cleanAll,
    });

    const results = [];
    for (const ext of cleanAll) {
        const isOnline = cleanOnline.includes(ext);
        try {
            const res = await pauseQueueMember({
                extension: ext,
                paused: !isOnline,
                reason: isOnline ? "online_eva" : "offline_eva",
                queue,
            });
            results.push({ extension: ext, isOnline, ok: true, details: res });
        } catch (err) {
            results.push({ extension: ext, isOnline, ok: false, error: err.message });
        }
    }

    return {
        queue,
        online: cleanOnline,
        all: cleanAll,
        results,
    };
}

async function getQueueStatus(queue = "") {
    ensureReady();
    const action = { Action: "QueueStatus" };
    if (queue) {
        action.Queue = String(queue).trim();
    }
    return runAmiAction(action);
}

module.exports = {
    start,
    stop,
    getStatus,
    getCallEvents,
    getCallsSummary,
    getCallByLinkedId,
    getCallDiagnostics,
    getAmiStatus,
    hangupCall,
    connectCallToExtension,
    redirectCallToStasis,
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
    getQueueStatus,
    extractExtensionNumber,
    __test: {
        updateCallSummary,
        resetCallTracking() {
            callEvents.length = 0;
            callsByLinkedId.clear();
            rawEventsByLinkedId.clear();
            actionsByLinkedId.clear();
        },
    },
};
