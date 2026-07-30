const assert = require("assert");

const {
    OutboundCallService,
} = require("../src/modules/outbound/outbound-call.service");

class FakePbxService {
    constructor() {
        this.managerListener = null;
        this.metadataResolver = null;
        this.originateRequests = [];
        this.hangups = [];
    }

    onManagerEvent(listener) {
        this.managerListener = listener;
        return () => {
            this.managerListener = null;
        };
    }

    registerEventMetadataResolver(resolver) {
        this.metadataResolver = resolver;
        return () => {
            this.metadataResolver = null;
        };
    }

    async originateOutboundApplication(payload) {
        this.originateRequests.push(payload);

        return {
            actionId: payload.actionId,
            channel: `Local/${payload.phoneNumber}@from-internal/n`,
            response: {
                response: "Success",
                message: "Originate successfully queued",
            },
        };
    }

    async hangupCall(linkedid, reason) {
        this.hangups.push({ linkedid, reason });
        return { ok: true };
    }

    async hangupChannelByName(channel, reason) {
        this.hangups.push({ channel, reason });
        return { ok: true };
    }

    emit(event) {
        this.managerListener?.(event);
    }
}

class FakeAriService {
    onSessionEvent(listener) {
        this.listener = listener;
        return () => {
            this.listener = null;
        };
    }

    emit(session, summary) {
        this.listener?.(session, summary);
    }
}

async function run() {
    const disabled = new OutboundCallService({
        env: {
            trunkOutboundEnabled: false,
            pbxOriginateContext: "from-internal",
            ariAppName: "ariana-trunk",
        },
        pbxService: new FakePbxService(),
        ariService: new FakeAriService(),
        laravelService: {
            sendTrunkCallEvent: async () => ({ ok: true }),
        },
    });

    await assert.rejects(
        () => disabled.createOutboundCall({
            phone_number: "0996432301",
            agent_id: 15,
            device_id: 8,
        }),
        (error) => error.status === 409
    );

    const pbx = new FakePbxService();
    const ari = new FakeAriService();
    const callbacks = [];
    const service = new OutboundCallService({
        env: {
            trunkOutboundEnabled: true,
            trunkOutboundRetentionMs: 3600000,
            pbxOriginateContext: "from-internal",
            ariAppName: "ariana-trunk",
            laravelTrunkEventsEnabled: true,
        },
        pbxService: pbx,
        ariService: ari,
        laravelService: {
            async sendTrunkCallEvent(payload) {
                callbacks.push(payload);
                return { ok: true };
            },
        },
        randomUUID: () => "11111111-2222-4333-8444-555555555555",
        now: () => new Date("2026-07-27T15:00:00.000Z"),
    });

    await assert.rejects(
        () => service.createOutboundCall({
            phone_number: "0996;DROP",
            agent_id: 15,
            device_id: 8,
        }),
        (error) => error.status === 422
    );

    const created = await service.createOutboundCall({
        phone_number: "0996432301",
        from_number: "1800-CORE-01",
        agent_id: 15,
        device_id: 8,
        customer_id: 42,
        tenant: "base_tenant",
        mode: "human",
    });

    assert.strictEqual(created.status, "ORIGINATING");
    assert.strictEqual(created.direction, "OUTBOUND");
    assert.strictEqual(created.outbound_call_id, "11111111-2222-4333-8444-555555555555");
    assert.strictEqual(pbx.originateRequests.length, 1);
    assert.strictEqual(pbx.originateRequests[0].phoneNumber, "0996432301");
    assert.strictEqual(
        pbx.originateRequests[0].variables.__ARIANA_OUTBOUND_CALL_ID,
        created.outbound_call_id
    );
    assert.strictEqual(
        pbx.originateRequests[0].applicationData,
        `ariana-trunk,outbound,${created.outbound_call_id}`
    );

    const earlyMetadata = pbx.metadataResolver({
        channel: "Local/0996432301@from-internal-00000001;1",
        event: "dialbegin",
    });

    assert.strictEqual(earlyMetadata.direction, "OUTBOUND");
    assert.strictEqual(earlyMetadata.device_id, 8);
    assert.strictEqual(earlyMetadata.phone_number, "0996432301");
    assert.strictEqual(earlyMetadata.from_number, "1800-CORE-01");

    pbx.emit({
        event: "varset",
        variable: "ARIANA_OUTBOUND_CALL_ID",
        value: created.outbound_call_id,
        uniqueid: "pbx-linked-outbound-1",
        linkedid: "pbx-linked-outbound-1",
        channel: "Local/0996432301@from-internal-00000001;1",
    });
    pbx.emit({
        event: "originateresponse",
        actionId: created.action_id,
        response: "Success",
        reason: "4",
        uniqueid: "pbx-linked-outbound-1",
        channel: "Local/0996432301@from-internal-00000001;1",
    });

    assert.strictEqual(service.getOutboundCall(created.outbound_call_id).status, "ANSWERED");
    assert.strictEqual(
        service.getOutboundCall(created.outbound_call_id).linkedid,
        "pbx-linked-outbound-1"
    );

    ari.emit(
        {
            linkedid: "pbx-linked-outbound-1",
            channelId: "ari-channel-1",
            channel: {
                name: "Local/0996432301@from-internal-00000001;1",
            },
            stasisArgs: ["outbound", created.outbound_call_id],
        },
        {
            type: "StasisStart",
        }
    );

    assert.strictEqual(
        service.getOutboundCall(created.outbound_call_id).status,
        "STASIS_READY"
    );

    const cancelled = await service.hangupOutboundCall(
        created.outbound_call_id,
        "test_cancel"
    );

    assert.strictEqual(cancelled.status, "CANCELLED");
    assert.deepStrictEqual(pbx.hangups[0], {
        linkedid: "pbx-linked-outbound-1",
        reason: "test_cancel",
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(callbacks.length >= 3);
    assert.ok(callbacks.every((payload) => payload.direction === "OUTBOUND"));
    assert.ok(callbacks.every((payload) => payload.outbound_call_id === created.outbound_call_id));

    console.log("Outbound trunk call service contract tests passed");
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
