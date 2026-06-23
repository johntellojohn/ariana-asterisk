const AsteriskManager = require("asterisk-manager");
const env = require("../../config/env");
const laravelService = require("../laravel/laravel.service");

const trackedEvents = new Set(["dialbegin", "dialend", "bridgeenter", "hangup"]);

let ami = null;
let started = false;
let connected = false;
let lastAmiEventTime = null;
let lastAmiError = null;

const callEvents = [];
const callsByLinkedId = new Map();

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

    if (env.pbxLogRawEvents) {
        console.log("[pbx:event:raw]", {
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
            linkedid:
                event.linkedid ||
                event.Linkedid ||
                event.uniqueid ||
                event.Uniqueid ||
                "",
        });
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
    notifyLaravel(normalized);
}

function normalizeEventName(event) {
    return String(event.event || event.Event || "").toLowerCase().trim();
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

async function hangupCall(linkedid, reason = "laravel_hangup") {
    validateRequired({ linkedid });
    ensureReady();
    console.log("[pbx:action] hangup requested", { linkedid, reason });

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
        results.push({
            channel,
            response: await hangupChannel(channel, reason),
        });
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

    const call = callsByLinkedId.get(linkedid);

    if (!call) {
        const error = new Error("PBX call not found");
        error.status = 404;
        throw error;
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
    }).then((response) => ({
        linkedid,
        channel,
        context: targetContext,
        extension,
        response,
    }));
}

function primaryCallChannel(call) {
    const dialBegin = [...call.events]
        .reverse()
        .find((event) => event.event === "dialbegin" && event.channel);

    return dialBegin?.channel || call.channels[0] || "";
}

function notifyLaravel(event) {
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

    return new Promise((resolve, reject) => {
        ami.action(
            {
                Action: "Originate",
                ...action,
            },
            (error, response) => {
                if (error) {
                    return reject(error);
                }

                return resolve(response);
            }
        );
    });
}

function hangupChannel(channel, reason) {
    console.log("[pbx:ami-action] Hangup", { channel, reason });

    return new Promise((resolve, reject) => {
        ami.action(
            {
                Action: "Hangup",
                Channel: channel,
                Cause: env.pbxHangupCause,
                Reason: reason,
            },
            (error, response) => {
                if (error) {
                    return reject(error);
                }

                return resolve(response);
            }
        );
    });
}

function redirectChannel(channel, target) {
    console.log("[pbx:ami-action] Redirect", { channel, ...target });

    return new Promise((resolve, reject) => {
        ami.action(
            {
                Action: "Redirect",
                Channel: channel,
                Context: target.context,
                Exten: target.extension,
                Priority: target.priority,
            },
            (error, response) => {
                if (error) {
                    return reject(error);
                }

                return resolve(response);
            }
        );
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

module.exports = {
    start,
    stop,
    getStatus,
    getCallEvents,
    getCallsSummary,
    getCallByLinkedId,
    hangupCall,
    connectCallToExtension,
    originateExtension,
    originateExternal,
    originateDirect,
};
