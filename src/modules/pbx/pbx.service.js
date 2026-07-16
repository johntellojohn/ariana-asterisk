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

function handleManagerEvent(event) {
    const eventName = normalizeEventName(event);
    const raw = normalizeRawEvent(event, eventName);

    rememberRawEvent(raw);

    if (shouldLogRawEvent(raw)) {
        console.log("[pbx:event:raw]", raw);
    }

    if (!trackedEvents.has(eventName)) {
        return;
    }

    const now = new Date().toISOString();
    lastAmiEventTime = now;

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
}

function normalizeEventName(event) {
    return String(event.event || event.Event || "").toLowerCase().trim();
}

function normalizeRawEvent(event, eventName = normalizeEventName(event)) {
    return {
        time: new Date().toISOString(),
        event: eventName || event.event || event.Event || "",
        channel: event.channel || event.Channel || "",
        caller: event.calleridnum || event.CallerIDNum || "",
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
                call.status = event.dialStatus;
            }
            if (event.dialStatus === "ANSWER") {
                call.answered = true;
            }
            break;
        case "bridgeenter":
            call.bridged = true;
            if (call.status === "IN_PROGRESS") {
                call.status = "ANSWER";
            }
            break;
        case "hangup":
            call.hangupCause = event.cause || call.hangupCause;
            call.hangupText = event.causeTxt || call.hangupText;
            if (!call.status || call.status === "IN_PROGRESS") {
                call.status = "HANGUP";
            }
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
    if (call.answered || call.bridged || call.status === "ANSWER") {
        return "answered";
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

    if (call.status === "HANGUP") {
        return "hangup";
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

    const call = callsByLinkedId.get(linkedid);

    if (!call) {
        const error = new Error("PBX call not found");
        error.status = 404;
        throw error;
    }

    if (isFinalCallStatus(call.status)) {
        const error = new Error(`La llamada PBX ya no esta activa (${call.status}). No se puede redirigir a ARI/Stasis.`);
        error.status = 409;
        rememberAction(linkedid, "redirect_stasis_rejected_final_status", {
            status: call.status,
            result: call.result,
            channels: call.channels,
        });
        throw error;
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

    const summary = event.linkedid ? getCallByLinkedId(event.linkedid) : null;
    const payload = {
        event,
        summary,
        source: "ariana-asterisk-pbx",
    };

    if (env.pbxLogLaravelCallbacks) {
        console.log("[pbx:laravel] sending trunk event", {
            linkedid: event.linkedid || null,
            event: event.event || null,
            url: `${env.laravelApiUrl.replace(/\/$/, "")}${env.laravelTrunkEventsPath}`,
            hasSummary: Boolean(summary),
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

    if (call.answered || call.bridged) {
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
    const channel = String(event.channel || "");
    const eventName = String(event.event || "").toLowerCase();

    return channel.startsWith("UnicastRTP/") && ["bridgeleave", "hangup"].includes(eventName);
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
        CallerID: callerId(phoneNumber),
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

function callerId(target) {
    return `${env.pbxCallerIdPrefix} -> ${target}`;
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
    originateExtension,
    originateExternal,
    originateDirect,
};
