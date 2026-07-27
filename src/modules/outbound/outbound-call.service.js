const crypto = require("crypto");

const env = require("../../config/env");
const ariService = require("../ari/ari.service");
const laravelService = require("../laravel/laravel.service");
const pbxService = require("../pbx/pbx.service");

const FINAL_STATUSES = new Set([
    "BUSY",
    "NOANSWER",
    "FAILED",
    "CANCELLED",
    "ENDED",
]);

class OutboundCallService {
    constructor(options = {}) {
        this.env = options.env || env;
        this.pbxService = options.pbxService || pbxService;
        this.ariService = options.ariService || ariService;
        this.laravelService = options.laravelService || laravelService;
        this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
        this.now = options.now || (() => new Date());
        this.callsById = new Map();
        this.callsByActionId = new Map();
        this.callsByLinkedId = new Map();

        if (typeof this.pbxService.onManagerEvent === "function") {
            this.unsubscribeManagerEvents = this.pbxService.onManagerEvent((event) => {
                this.handleManagerEvent(event);
            });
        }

        if (typeof this.pbxService.registerEventMetadataResolver === "function") {
            this.unsubscribeMetadataResolver = this.pbxService.registerEventMetadataResolver(
                (event) => this.metadataForEvent(event)
            );
        }

        if (typeof this.ariService.onSessionEvent === "function") {
            this.unsubscribeAriEvents = this.ariService.onSessionEvent((session, summary) => {
                this.handleAriSessionEvent(session, summary);
            });
        }
    }

    async createOutboundCall(payload = {}) {
        this.ensureEnabled();
        this.prune();

        const input = this.validatePayload(payload);
        const outboundCallId = this.randomUUID();
        const actionId = `ariana-outbound-${outboundCallId}`;
        const now = this.timestamp();
        const call = {
            outboundCallId,
            actionId,
            linkedid: "",
            uniqueid: "",
            channel: "",
            channelPrefix: `Local/${input.phoneNumber}@${this.env.pbxOriginateContext}-`,
            status: "QUEUED",
            direction: "OUTBOUND",
            phoneNumber: input.phoneNumber,
            fromNumber: input.fromNumber,
            agentId: input.agentId,
            deviceId: input.deviceId,
            customerId: input.customerId,
            tenant: input.tenant,
            mode: input.mode,
            createdAt: now,
            updatedAt: now,
            answeredAt: null,
            endedAt: null,
            lastEvent: "outbound_requested",
            lastError: null,
            amiResponse: null,
        };

        this.remember(call);

        try {
            const originate = await this.pbxService.originateOutboundApplication({
                actionId,
                phoneNumber: input.phoneNumber,
                application: "Stasis",
                applicationData: `${this.env.ariAppName},outbound,${outboundCallId}`,
                variables: this.channelVariables(call),
            });

            call.channel = String(originate.channel || "");
            call.status = "ORIGINATING";
            call.lastEvent = "originate_queued";
            call.amiResponse = this.safeAmiResponse(originate.response);
            call.updatedAt = this.timestamp();
            this.publishState(call, "originate_queued");

            return this.snapshot(call);
        } catch (error) {
            call.status = "FAILED";
            call.lastEvent = "originate_failed";
            call.lastError = error.message || String(error);
            call.endedAt = this.timestamp();
            call.updatedAt = call.endedAt;
            this.publishState(call, "originate_failed");

            error.status = error.status || 502;
            error.outboundCallId = outboundCallId;
            throw error;
        }
    }

    listOutboundCalls() {
        this.prune();

        return [...this.callsById.values()]
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map((call) => this.snapshot(call));
    }

    getOutboundCall(outboundCallId) {
        const call = this.callsById.get(String(outboundCallId || ""));

        return call ? this.snapshot(call) : null;
    }

    async hangupOutboundCall(outboundCallId, reason = "outbound_cancelled") {
        const call = this.requireCall(outboundCallId);

        if (FINAL_STATUSES.has(call.status)) {
            return this.snapshot(call);
        }

        if (call.linkedid) {
            try {
                await this.pbxService.hangupCall(call.linkedid, reason);
            } catch (error) {
                if (!call.channel) {
                    throw error;
                }

                await this.pbxService.hangupChannelByName(call.channel, reason);
            }
        } else if (call.channel) {
            await this.pbxService.hangupChannelByName(call.channel, reason);
        } else {
            const error = new Error("Outbound call does not have an Asterisk channel yet");
            error.status = 409;
            throw error;
        }

        call.status = "CANCELLED";
        call.lastEvent = "hangup_requested";
        call.endedAt = this.timestamp();
        call.updatedAt = call.endedAt;
        this.publishState(call, "hangup_requested");

        return this.snapshot(call);
    }

    metadataForEvent(event = {}) {
        const call = this.findCallForEvent(event);

        if (!call) {
            return null;
        }

        return {
            direction: "OUTBOUND",
            outbound_call_id: call.outboundCallId,
            external_call_id: call.linkedid || call.outboundCallId,
            agent_id: call.agentId,
            device_id: call.deviceId,
            customer_id: call.customerId || null,
            tenant: call.tenant || undefined,
            mode: call.mode,
        };
    }

    handleManagerEvent(event = {}) {
        try {
            const eventName = String(event.event || "").toLowerCase();
            const variableName = String(event.variable || "").replace(/^_+/, "");

            if (eventName === "varset" && variableName === "ARIANA_OUTBOUND_CALL_ID") {
                const call = this.callsById.get(String(event.value || ""));

                if (call) {
                    this.linkCall(call, event);
                }

                return;
            }

            if (eventName === "originateresponse") {
                this.handleOriginateResponse(event);
                return;
            }

            const call = this.findCallForEvent(event);

            if (!call) {
                return;
            }

            this.linkCall(call, event);
            this.applyManagerStatus(call, event);
        } catch (error) {
            console.warn("[outbound] manager event processing failed", {
                event: event.event || null,
                linkedid: event.linkedid || null,
                message: error.message,
            });
        }
    }

    handleAriSessionEvent(session = {}, summary = {}) {
        try {
            const args = Array.isArray(session.stasisArgs)
                ? session.stasisArgs.map((value) => String(value))
                : [];
            const outboundCallId = args.find((value) => this.callsById.has(value));
            const call = outboundCallId
                ? this.callsById.get(outboundCallId)
                : this.callsByLinkedId.get(String(session.linkedid || ""));

            if (!call) {
                return;
            }

            this.linkCall(call, {
                linkedid: session.linkedid,
                uniqueid: session.channelId,
                channel: session.channel?.name,
            });

            const type = String(summary.type || "");

            if (type === "StasisStart") {
                call.status = "STASIS_READY";
                call.lastEvent = "stasis_ready";
                call.answeredAt ||= this.timestamp();
                call.updatedAt = this.timestamp();
                this.publishState(call, "stasis_ready");
            } else if (["StasisEnd", "ChannelDestroyed"].includes(type)) {
                call.status = "ENDED";
                call.lastEvent = "ended";
                call.endedAt = this.timestamp();
                call.updatedAt = call.endedAt;
                this.publishState(call, "ended");
            }
        } catch (error) {
            console.warn("[outbound] ARI event processing failed", {
                type: summary.type || null,
                linkedid: session.linkedid || null,
                message: error.message,
            });
        }
    }

    handleOriginateResponse(event) {
        const call = this.callsByActionId.get(String(event.actionId || ""));

        if (!call) {
            return;
        }

        this.linkCall(call, event);

        const response = String(event.response || "").toLowerCase();
        const reason = Number(event.reason || 0);

        if (response === "success") {
            call.status = "ANSWERED";
            call.answeredAt ||= this.timestamp();
            call.lastError = null;
        } else {
            call.status = this.statusForOriginateFailure(reason);
            call.lastError = `AMI Originate failed${reason ? ` with reason ${reason}` : ""}`;
            call.endedAt = this.timestamp();
        }

        call.lastEvent = "originate_response";
        call.updatedAt = this.timestamp();
        this.publishState(call, "originate_response");
    }

    applyManagerStatus(call, event) {
        const eventName = String(event.event || "").toLowerCase();
        const dialStatus = String(event.dialStatus || "").toUpperCase();
        let nextStatus = "";

        if (["dialbegin", "dialstate"].includes(eventName)) {
            nextStatus = "RINGING";
        } else if (eventName === "dialend") {
            nextStatus = {
                ANSWER: "ANSWERED",
                BUSY: "BUSY",
                NOANSWER: "NOANSWER",
                CANCEL: "CANCELLED",
                CHANUNAVAIL: "FAILED",
                CONGESTION: "FAILED",
            }[dialStatus] || dialStatus;
        } else if (eventName === "bridgeenter") {
            nextStatus = "ANSWERED";
        } else if (eventName === "hangup") {
            nextStatus = FINAL_STATUSES.has(call.status) ? call.status : "ENDED";
        }

        if (!nextStatus) {
            return;
        }

        call.status = nextStatus;
        call.lastEvent = eventName;
        call.updatedAt = this.timestamp();

        if (nextStatus === "ANSWERED") {
            call.answeredAt ||= call.updatedAt;
        }

        if (FINAL_STATUSES.has(nextStatus)) {
            call.endedAt ||= call.updatedAt;
        }
    }

    findCallForEvent(event = {}) {
        const variableName = String(event.variable || "").replace(/^_+/, "");
        const outboundCallId = String(
            event.outbound_call_id ||
            event.outboundCallId ||
            (variableName === "ARIANA_OUTBOUND_CALL_ID" ? event.value : "") ||
            ""
        );

        if (outboundCallId && this.callsById.has(outboundCallId)) {
            return this.callsById.get(outboundCallId);
        }

        const actionId = String(event.actionId || "");

        if (actionId && this.callsByActionId.has(actionId)) {
            return this.callsByActionId.get(actionId);
        }

        for (const id of [event.linkedid, event.uniqueid]) {
            const value = String(id || "");

            if (value && this.callsByLinkedId.has(value)) {
                return this.callsByLinkedId.get(value);
            }
        }

        const channels = [event.channel, event.destChannel]
            .map((value) => String(value || ""))
            .filter(Boolean);
        const candidates = [...this.callsById.values()].filter((call) => {
            if (FINAL_STATUSES.has(call.status)) {
                return false;
            }

            return channels.some((channel) => channel.startsWith(call.channelPrefix));
        });

        return candidates.length === 1 ? candidates[0] : null;
    }

    linkCall(call, event = {}) {
        const candidate = String(event.linkedid || event.uniqueid || "");
        const linkedid = ["", "null", "<null>"].includes(candidate.toLowerCase())
            ? ""
            : candidate;

        if (linkedid) {
            call.linkedid = linkedid;
            this.callsByLinkedId.set(linkedid, call);
        }

        if (event.uniqueid) {
            call.uniqueid = String(event.uniqueid);
            this.callsByLinkedId.set(call.uniqueid, call);
        }

        if (event.channel) {
            call.channel = String(event.channel);
        }

        call.updatedAt = this.timestamp();
    }

    channelVariables(call) {
        const variables = {
            __ARIANA_OUTBOUND_CALL_ID: call.outboundCallId,
            __ARIANA_DIRECTION: "OUTBOUND",
            __ARIANA_AGENT_ID: call.agentId,
            __ARIANA_DEVICE_ID: call.deviceId,
            __ARIANA_MODE: call.mode,
        };

        if (call.customerId) {
            variables.__ARIANA_CUSTOMER_ID = call.customerId;
        }

        if (call.tenant) {
            variables.__ARIANA_TENANT = call.tenant;
        }

        return variables;
    }

    validatePayload(payload) {
        const phoneNumber = String(payload.phone_number || payload.phoneNumber || "").trim();
        const fromNumber = String(payload.from_number || payload.fromNumber || "").trim();
        const agentId = this.positiveInteger(payload.agent_id || payload.agentId, "agent_id");
        const deviceId = this.positiveInteger(payload.device_id || payload.deviceId, "device_id");
        const customerId = this.optionalPositiveInteger(
            payload.customer_id || payload.customerId,
            "customer_id"
        );
        const tenant = String(payload.tenant || payload.database || "").trim();
        const mode = String(payload.mode || "human").trim().toLowerCase();

        if (!/^\+?[0-9]{3,20}$/.test(phoneNumber)) {
            const error = new Error("phone_number must contain between 3 and 20 digits");
            error.status = 422;
            throw error;
        }

        if (fromNumber && !/^[A-Za-z0-9+_.-]{1,80}$/.test(fromNumber)) {
            const error = new Error("from_number has an invalid format");
            error.status = 422;
            throw error;
        }

        if (tenant && !/^[A-Za-z0-9_-]{1,100}$/.test(tenant)) {
            const error = new Error("tenant has an invalid format");
            error.status = 422;
            throw error;
        }

        if (!["human", "ai"].includes(mode)) {
            const error = new Error("mode must be human or ai");
            error.status = 422;
            throw error;
        }

        return {
            phoneNumber,
            fromNumber,
            agentId,
            deviceId,
            customerId,
            tenant,
            mode,
        };
    }

    positiveInteger(value, field) {
        const parsed = Number(value);

        if (!Number.isInteger(parsed) || parsed <= 0) {
            const error = new Error(`${field} must be a positive integer`);
            error.status = 422;
            throw error;
        }

        return parsed;
    }

    optionalPositiveInteger(value, field) {
        if (value === undefined || value === null || value === "") {
            return null;
        }

        return this.positiveInteger(value, field);
    }

    statusForOriginateFailure(reason) {
        return {
            1: "NOANSWER",
            5: "BUSY",
            8: "FAILED",
        }[reason] || "FAILED";
    }

    ensureEnabled() {
        if (!this.env.trunkOutboundEnabled) {
            const error = new Error("Trunk outbound calls are disabled");
            error.status = 409;
            throw error;
        }
    }

    requireCall(outboundCallId) {
        const call = this.callsById.get(String(outboundCallId || ""));

        if (!call) {
            const error = new Error("Outbound call not found");
            error.status = 404;
            throw error;
        }

        return call;
    }

    remember(call) {
        this.callsById.set(call.outboundCallId, call);
        this.callsByActionId.set(call.actionId, call);
    }

    prune() {
        const retentionMs = Math.max(60000, Number(this.env.trunkOutboundRetentionMs || 3600000));
        const threshold = this.now().getTime() - retentionMs;

        for (const call of this.callsById.values()) {
            const updatedAt = new Date(call.updatedAt).getTime();

            if (!FINAL_STATUSES.has(call.status) || updatedAt >= threshold) {
                continue;
            }

            this.callsById.delete(call.outboundCallId);
            this.callsByActionId.delete(call.actionId);

            for (const [linkedid, linkedCall] of this.callsByLinkedId.entries()) {
                if (linkedCall === call) {
                    this.callsByLinkedId.delete(linkedid);
                }
            }
        }
    }

    publishState(call, eventName) {
        if (!this.env.laravelTrunkEventsEnabled) {
            return;
        }

        const externalCallId = call.linkedid || call.outboundCallId;
        const payload = {
            source: "ariana-asterisk-outbound",
            direction: "OUTBOUND",
            outbound_call_id: call.outboundCallId,
            device_id: call.deviceId,
            customer_id: call.customerId,
            agent_id: call.agentId,
            tenant: call.tenant || undefined,
            mode: call.mode,
            event: {
                time: this.timestamp(),
                event: eventName,
                status: call.status,
                caller: call.fromNumber,
                destination: call.phoneNumber,
                linkedid: externalCallId,
                external_call_id: externalCallId,
                uniqueid: call.uniqueid,
                channel: call.channel,
                direction: "OUTBOUND",
                outbound_call_id: call.outboundCallId,
            },
            summary: {
                linkedid: externalCallId,
                status: call.status,
                from: call.fromNumber,
                to: call.phoneNumber,
                direction: "OUTBOUND",
                outbound_call_id: call.outboundCallId,
                answered: Boolean(call.answeredAt),
                result: this.resultForStatus(call.status),
            },
        };

        Promise.resolve(this.laravelService.sendTrunkCallEvent(payload)).catch((error) => {
            console.error("[outbound:laravel] callback failed", {
                outboundCallId: call.outboundCallId,
                event: eventName,
                message: error.message,
                status: error.response?.status,
            });
        });
    }

    resultForStatus(status) {
        return {
            ANSWERED: "answered",
            STASIS_READY: "answered",
            BUSY: "busy",
            NOANSWER: "no_answer",
            CANCELLED: "cancelled",
            FAILED: "failed",
            ENDED: "ended",
        }[status] || "in_progress";
    }

    safeAmiResponse(response) {
        if (!response || typeof response !== "object") {
            return response || null;
        }

        return {
            response: response.response || response.Response || null,
            message: response.message || response.Message || null,
            actionId: response.actionid || response.ActionID || null,
        };
    }

    snapshot(call) {
        return {
            outbound_call_id: call.outboundCallId,
            action_id: call.actionId,
            external_call_id: call.linkedid || call.outboundCallId,
            linkedid: call.linkedid || null,
            uniqueid: call.uniqueid || null,
            channel: call.channel || null,
            status: call.status,
            direction: call.direction,
            phone_number: call.phoneNumber,
            from_number: call.fromNumber || null,
            agent_id: call.agentId,
            device_id: call.deviceId,
            customer_id: call.customerId,
            tenant: call.tenant || null,
            mode: call.mode,
            created_at: call.createdAt,
            updated_at: call.updatedAt,
            answered_at: call.answeredAt,
            ended_at: call.endedAt,
            last_event: call.lastEvent,
            last_error: call.lastError,
        };
    }

    timestamp() {
        return this.now().toISOString();
    }
}

const outboundCallService = new OutboundCallService();

module.exports = outboundCallService;
module.exports.OutboundCallService = OutboundCallService;
