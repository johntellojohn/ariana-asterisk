const TERMINAL_STATUSES = new Set([
    "ENDED",
    "ABANDONED",
    "CANCELLED",
    "NOANSWER",
    "BUSY",
    "FAILED",
]);

const PHASE_RANK = {
    NEW: 1,
    QUEUE_WAITING: 2,
    RINGING: 3,
    ANSWERED: 4,
    BRIDGED: 4,
    ENDED: 10,
    ABANDONED: 10,
    CANCELLED: 10,
    NOANSWER: 10,
    BUSY: 10,
    FAILED: 10,
};

const AGENT_LOCAL_CONTEXTS = [
    "@from-queue",
    "@ext-queues",
    "@simulador-agente",
    "@from-internal",
    "@from-did-direct",
];

const NON_SIGNALING_AGENT_EXACT_NAMES = new Set([
    "varset",
    "newexten",
    "rtcpsent",
    "rtcpreceived",
    "newconnectedline",
    "hold",
    "unhold",
    "musiconholdstart",
    "musiconholdstop",
    "softhanguprequest",
    "hanguprequest",
]);

function isTerminalStatus(status) {
    return TERMINAL_STATUSES.has(String(status || "").toUpperCase());
}

/**
 * Classifies an Asterisk channel into:
 * - 'internal_media': UnicastRTP ExternalMedia legs
 * - 'agent_leg': Agent ring/dial sub-channels spawned by Queue or internal dialplan
 * - 'trunk_or_caller': Caller trunk (SIP/PJSIP/DAHDI/IAX2) or queue-entry Local simulator leg
 */
function classifyChannel(channelName = "", context = "") {
    const ch = String(channelName || "").trim();
    const ctx = String(context || "").trim().toLowerCase();

    if (!ch) {
        return "unknown";
    }

    if (ch.startsWith("UnicastRTP/")) {
        return "internal_media";
    }

    if (ch.startsWith("Local/")) {
        const lower = ch.toLowerCase();
        if (AGENT_LOCAL_CONTEXTS.some((marker) => lower.includes(marker))) {
            return "agent_leg";
        }
        if (lower.includes("@simulador-cola") || lower.includes("@from-pstn") || ctx.includes("queue") || ctx.includes("pstn")) {
            return "caller_leg";
        }
        // Fallback: ';2' on other Local channels can be dialplan queue leg; treat ';1' as outbound dial leg unless confirmed caller
        if (lower.endsWith(";2")) {
            return "caller_leg";
        }
        return "local_other";
    }

    if (/^(SIP|PJSIP|DAHDI|IAX2|MOTIF|MOBILE)\//i.test(ch)) {
        return "trunk_or_sip";
    }

    return "other";
}

function mapDialStatusToTerminal(dialStatus) {
    const clean = String(dialStatus || "").trim().toUpperCase();
    switch (clean) {
        case "BUSY":
            return "BUSY";
        case "NOANSWER":
        case "CONGESTION":
            return "NOANSWER";
        case "CANCEL":
            return "CANCELLED";
        case "CHANUNAVAIL":
            return "FAILED";
        default:
            return null;
    }
}

/**
 * Forward-only monotonic call state machine for edge PBX tracking, wait-vs-talk
 * timestamps, and guaranteed single terminal webhook emission.
 */
class CallStateService {
    constructor(options = {}) {
        this.calls = new Map();
        this.maxEndedAgeMs = Number(options.maxEndedAgeMs) || 15 * 60 * 1000;
        this.maxActiveAgeMs = Number(options.maxActiveAgeMs) || 4 * 60 * 60 * 1000;
        this.maxCalls = Number(options.maxCalls) || 2000;
        this.redirectPendingByLinkedId = new Map();
    }

    markStasisRedirectPending(linkedid, ttlMs = 15000) {
        if (!linkedid) return;
        this.redirectPendingByLinkedId.set(String(linkedid), Date.now() + ttlMs);
    }

    clearStasisRedirectPending(linkedid) {
        if (!linkedid) return;
        this.redirectPendingByLinkedId.delete(String(linkedid));
    }

    hasStasisRedirectPending(linkedid, nowMs = Date.now()) {
        if (!linkedid) return false;
        const expiry = this.redirectPendingByLinkedId.get(String(linkedid));
        if (!expiry) return false;
        if (nowMs > expiry) {
            this.redirectPendingByLinkedId.delete(String(linkedid));
            return false;
        }
        return true;
    }

    getCall(linkedid) {
        return linkedid ? this.calls.get(String(linkedid)) || null : null;
    }

    getAllCalls() {
        return Array.from(this.calls.values());
    }

    getActiveCount() {
        let count = 0;
        for (const call of this.calls.values()) {
            if (!isTerminalStatus(call.status)) {
                count += 1;
            }
        }
        return count;
    }

    ensureCall(linkedid, event = {}) {
        const key = String(linkedid);
        const nowIso = event.timestamp || new Date().toISOString();
        let call = this.calls.get(key);

        if (!call) {
            call = {
                linkedid: key,
                status: "NEW",
                primaryChannel: null,
                agentChannels: new Set(),
                channels: new Set(),
                queue: null,
                callerNumber: null,
                callerName: null,
                targetExtension: null,
                answeredExtension: null,
                firstEventAt: nowIso,
                queueJoinedAt: null,
                ringStartedAt: null,
                answeredAt: null,
                endedAt: null,
                lastEventAt: nowIso,
                answered: false,
                bridged: false,
                terminalEmitted: false,
                incomingEmitted: false,
                answeredEmitted: false,
                lastRingExtensionEmitted: null,
                hangupCause: null,
                hangupText: null,
                terminalReason: null,
                updatedAtMs: Date.now(),
            };
            this.calls.set(key, call);
        }

        call.lastEventAt = nowIso;
        call.updatedAtMs = Date.now();
        return call;
    }

    updatePrimaryChannelCandidate(call, event) {
        const channel = String(event.channel || "").trim();
        if (!channel) return;

        const kind = classifyChannel(channel, event.context);
        if (kind === "internal_media") {
            return;
        }

        call.channels.add(channel);

        if (kind === "agent_leg") {
            call.agentChannels.add(channel);
            return;
        }

        // QueueCallerJoin channel is always the canonical caller leg waiting in queue
        const eventName = String(event.event || "").toLowerCase();
        if (eventName === "queuecallerjoin") {
            call.primaryChannel = channel;
            return;
        }

        if (!call.primaryChannel) {
            call.primaryChannel = channel;
            return;
        }

        // Upgrade Local caller channel to physical SIP/PJSIP/DAHDI trunk channel if both exist
        const currentKind = classifyChannel(call.primaryChannel);
        if (currentKind !== "trunk_or_sip" && kind === "trunk_or_sip" && eventName === "newchannel") {
            call.primaryChannel = channel;
        }
    }

    transitionForward(call, nextStatus) {
        const currentRank = PHASE_RANK[call.status] || 0;
        const nextRank = PHASE_RANK[nextStatus] || 0;

        if (isTerminalStatus(call.status)) {
            // Never revive a terminated call
            return false;
        }

        if (nextRank < currentRank && !isTerminalStatus(nextStatus)) {
            return false;
        }

        call.status = nextStatus;
        return true;
    }

    /**
     * Processes one normalized AMI event and returns structured decision:
     * {
     *   call,
     *   emit: boolean,
     *   emitEventName: string | null,
     *   dedupeKey: string | null,
     *   isTerminal: boolean,
     *   timing: { firstEventAt, queueJoinedAt, ringStartedAt, answeredAt, endedAt },
     *   reason: string
     * }
     */
    processEvent(event, options = {}) {
        const linkedid = String(event?.linkedid || event?.uniqueid || "").trim();
        if (!linkedid) {
            return { call: null, emit: false, emitEventName: null, dedupeKey: null, isTerminal: false, reason: "missing_linkedid" };
        }

        const eventName = String(event.event || "").trim().toLowerCase();
        const channel = String(event.channel || "").trim();
        const destChannel = String(event.destChannel || "").trim();
        const channelKind = classifyChannel(channel, event.context);

        if (channelKind === "internal_media" || classifyChannel(destChannel) === "internal_media") {
            return {
                call: this.getCall(linkedid),
                emit: false,
                emitEventName: null,
                dedupeKey: null,
                isTerminal: false,
                reason: "internal_media_ignored",
            };
        }

        if (NON_SIGNALING_AGENT_EXACT_NAMES.has(eventName)) {
            return {
                call: this.getCall(linkedid),
                emit: false,
                emitEventName: null,
                dedupeKey: null,
                isTerminal: false,
                reason: "noise_event_filtered",
            };
        }

        const nowIso = event.timestamp || new Date().toISOString();
        const call = this.ensureCall(linkedid, { ...event, timestamp: nowIso });
        this.updatePrimaryChannelCandidate(call, event);

        if (event.callerIdNum && !call.callerNumber && channel === call.primaryChannel) {
            call.callerNumber = String(event.callerIdNum).trim();
        }
        if (event.callerIdName && !call.callerName && channel === call.primaryChannel) {
            call.callerName = String(event.callerIdName).trim();
        }
        if (event.queue && !call.queue) {
            call.queue = String(event.queue).trim();
        }

        // Ignore further non-terminal churn after terminal transition
        if (isTerminalStatus(call.status)) {
            return {
                call,
                emit: false,
                emitEventName: null,
                dedupeKey: null,
                isTerminal: false,
                reason: "already_terminal",
            };
        }

        // Handle explicit queue caller abandonment -> immediate terminal ABANDONED
        if (eventName === "queuecallerabandon") {
            call.terminalReason = "queue_caller_abandon";
            call.endedAt = call.endedAt || nowIso;
            this.transitionForward(call, "ABANDONED");
            return this.buildTerminalEmission(call, "queuecallerabandon");
        }

        // Handle caller entering queue -> INCOMING / QUEUE_WAITING
        if (eventName === "queuecallerjoin") {
            if (!call.queueJoinedAt) {
                call.queueJoinedAt = nowIso;
            }
            if (event.callerIdNum && !call.callerNumber) {
                call.callerNumber = String(event.callerIdNum).trim();
            }
            this.transitionForward(call, "QUEUE_WAITING");

            if (!call.incomingEmitted) {
                call.incomingEmitted = true;
                return this.buildEmission(call, "queuecallerjoin", `INCOMING:${call.linkedid}`, false, "queue_join");
            }
            return this.buildNoop(call, "queue_join_already_emitted");
        }

        // Handle newchannel only for primary caller channel as initial fallback if not queued
        if (eventName === "newchannel") {
            const isOutbound = Boolean(options.isOutbound);
            if (channel === call.primaryChannel && !call.incomingEmitted && isOutbound) {
                call.incomingEmitted = true;
                return this.buildEmission(call, "newchannel", `INCOMING:${call.linkedid}`, false, "outbound_newchannel");
            }
            return this.buildNoop(call, "newchannel_tracked");
        }

        // Handle queue leave cleanly: not terminal by itself, wait for Bridge/Redirect/Abandon/Hangup
        if (eventName === "queuecallerleave") {
            return this.buildNoop(call, "queue_leave_suppressed");
        }

        // Handle ringing / agent assignment
        if (eventName === "agentcalled" || eventName === "dialbegin") {
            if (!call.ringStartedAt) {
                call.ringStartedAt = nowIso;
            }
            const ext = extractExt(event.destExtension || event.extension || destChannel || event.memberName || event.interface);
            if (ext) {
                call.targetExtension = ext;
            }
            this.transitionForward(call, "RINGING");

            if (!call.incomingEmitted) {
                call.incomingEmitted = true;
                call.lastRingExtensionEmitted = ext || null;
                return this.buildEmission(call, eventName, `INCOMING:${call.linkedid}`, false, "ring_initial");
            }

            if (ext && ext !== call.lastRingExtensionEmitted) {
                call.lastRingExtensionEmitted = ext;
                return this.buildEmission(call, eventName, `RING:${call.linkedid}:${ext}`, false, "ring_extension_update");
            }

            return this.buildNoop(call, "ring_deduped");
        }

        if (eventName === "newstate") {
            const stateDesc = String(event.channelStateDesc || "").trim().toLowerCase();
            if (stateDesc === "ringing" || stateDesc === "ring") {
                if (!call.ringStartedAt) {
                    call.ringStartedAt = nowIso;
                }
                this.transitionForward(call, "RINGING");
                if (!call.incomingEmitted && channel === call.primaryChannel) {
                    call.incomingEmitted = true;
                    return this.buildEmission(call, "newstate", `INCOMING:${call.linkedid}`, false, "ringing_newstate");
                }
            }
            return this.buildNoop(call, "newstate_tracked");
        }

        // Handle REAL answer only from AgentConnect, BridgeEnter on agent leg / active bridge, or DialEnd ANSWER
        if (eventName === "agentconnect") {
            return this.handleRealAnswer(call, nowIso, eventName, event);
        }

        if (eventName === "bridgeenter") {
            const numChannels = Number(event.bridgeNumChannels || 0);
            const isAgentOrSecondLeg =
                (channel && channel !== call.primaryChannel) ||
                numChannels >= 2 ||
                Boolean(options.bridgeVerified);

            if (isAgentOrSecondLeg) {
                call.bridged = true;
                return this.handleRealAnswer(call, nowIso, "bridgeenter", event);
            }
            return this.buildNoop(call, "bridgeenter_first_channel_wait");
        }

        if (eventName === "dialend") {
            const dialStatus = String(event.dialStatus || "").trim().toUpperCase();
            if (dialStatus === "ANSWER") {
                return this.handleRealAnswer(call, nowIso, "dialend", event);
            }

            // DialEnd fail before answer is ONLY terminal if the call has no primary queue wait or primary channel hung up
            const mappedFail = mapDialStatusToTerminal(dialStatus);
            const isPrimaryOrNoQueue = !call.queue && (!channel || channel === call.primaryChannel || Boolean(options.isOutbound));
            if (mappedFail && !call.answered && isPrimaryOrNoQueue && dialStatus !== "CANCEL") {
                call.endedAt = call.endedAt || nowIso;
                call.terminalReason = `dialend_${dialStatus.toLowerCase()}`;
                this.transitionForward(call, mappedFail);
                return this.buildTerminalEmission(call, "dialend");
            }
            return this.buildNoop(call, "dialend_non_terminal");
        }

        // Handle Hangup — primary caller channel hangup MUST emit terminal event unless Stasis redirect transition
        if (eventName === "hangup") {
            const isPrimary = Boolean(call.primaryChannel && channel === call.primaryChannel);
            const isAgentLeg = call.agentChannels.has(channel) || channelKind === "agent_leg";

            if (!isPrimary || isAgentLeg) {
                return this.buildNoop(call, "subchannel_hangup_ignored");
            }

            if (this.hasStasisRedirectPending(linkedid)) {
                // Only defer if this wasn't explicitly caller abandonment before answer
                return this.buildNoop(call, "stasis_redirect_in_progress");
            }

            call.hangupCause = event.cause !== undefined && event.cause !== null ? String(event.cause) : call.hangupCause;
            call.hangupText = event.causeTxt || call.hangupText;
            call.endedAt = call.endedAt || nowIso;

            const finalStatus = call.answered || call.bridged ? "ENDED" : "ABANDONED";
            call.terminalReason = finalStatus === "ENDED" ? "primary_hangup_after_answer" : "primary_hangup_before_answer";
            this.transitionForward(call, finalStatus);
            return this.buildTerminalEmission(call, finalStatus === "ABANDONED" ? "queuecallerabandon" : "hangup");
        }

        return this.buildNoop(call, "unhandled_non_emitting");
    }

    handleRealAnswer(call, nowIso, eventName, event) {
        call.answered = true;
        if (!call.answeredAt) {
            call.answeredAt = nowIso;
        }
        const ext = extractExt(
            event.destExtension || event.extension || event.memberName || event.interface || event.destChannel || event.channel
        );
        if (ext && (!call.primaryChannel || !String(call.primaryChannel).includes(ext))) {
            call.answeredExtension = ext;
            call.targetExtension = call.targetExtension || ext;
        }
        this.transitionForward(call, "ANSWERED");

        if (!call.answeredEmitted) {
            call.answeredEmitted = true;
            return this.buildEmission(call, eventName, `ANSWERED:${call.linkedid}`, false, "real_answer");
        }

        return this.buildNoop(call, "answer_already_emitted");
    }

    buildTerminalEmission(call, emitEventName) {
        if (call.terminalEmitted) {
            return this.buildNoop(call, "terminal_already_emitted");
        }
        call.terminalEmitted = true;
        return this.buildEmission(call, emitEventName, `TERMINAL:${call.linkedid}`, true, call.terminalReason || "terminal");
    }

    buildEmission(call, emitEventName, dedupeKey, isTerminal, reason) {
        return {
            call,
            emit: true,
            emitEventName,
            dedupeKey,
            isTerminal,
            timing: {
                firstEventAt: call.firstEventAt,
                queueJoinedAt: call.queueJoinedAt,
                ringStartedAt: call.ringStartedAt,
                answeredAt: call.answeredAt,
                endedAt: call.endedAt,
            },
            reason,
        };
    }

    buildNoop(call, reason) {
        return {
            call,
            emit: false,
            emitEventName: null,
            dedupeKey: null,
            isTerminal: false,
            timing: call
                ? {
                    firstEventAt: call.firstEventAt,
                    queueJoinedAt: call.queueJoinedAt,
                    ringStartedAt: call.ringStartedAt,
                    answeredAt: call.answeredAt,
                    endedAt: call.endedAt,
                }
                : null,
            reason,
        };
    }

    pruneStaleCalls(nowMs = Date.now()) {
        let removed = 0;

        for (const [linkedid, call] of this.calls.entries()) {
            const ageMs = nowMs - (call.updatedAtMs || nowMs);
            if (isTerminalStatus(call.status) && ageMs > this.maxEndedAgeMs) {
                this.calls.delete(linkedid);
                this.redirectPendingByLinkedId.delete(linkedid);
                removed += 1;
                continue;
            }
            if (!isTerminalStatus(call.status) && ageMs > this.maxActiveAgeMs) {
                this.calls.delete(linkedid);
                this.redirectPendingByLinkedId.delete(linkedid);
                removed += 1;
            }
        }

        if (this.calls.size > this.maxCalls) {
            const sorted = Array.from(this.calls.entries()).sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
            const overflow = this.calls.size - this.maxCalls;
            for (let i = 0; i < overflow; i += 1) {
                this.calls.delete(sorted[i][0]);
                removed += 1;
            }
        }

        return removed;
    }

    reset() {
        this.calls.clear();
        this.redirectPendingByLinkedId.clear();
    }
}

function extractExt(raw) {
    if (!raw) return "";
    const str = String(raw).trim();
    const direct = /^\d{2,6}$/.exec(str);
    if (direct) return direct[0];
    const ifaceMatch = /(?:SIP|PJSIP|Local)\/(\d{2,6})(?:[@\-\/;,]|$)/i.exec(str);
    return ifaceMatch ? ifaceMatch[1] : "";
}

const instance = new CallStateService();

module.exports = instance;
module.exports.CallStateService = CallStateService;
module.exports.classifyChannel = classifyChannel;
module.exports.isTerminalStatus = isTerminalStatus;

