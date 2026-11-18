const assert = require("assert");

const env = require("../src/config/env");
const ariService = require("../src/modules/ari/ari.service");
const ariBridgeService = require("../src/modules/ari/ari-bridge.service");
const ariMediaService = require("../src/modules/ari/ari-media.service");
const pbxService = require("../src/modules/pbx/pbx.service");
const callState = require("../src/modules/pbx/call-state.service");
const { CallStateService, classifyChannel } = callState;
const { resolveGatewayCapabilities } = require("../src/modules/pbx/asterisk-capabilities");

async function run() {
    // 1. Capabilities with sipBridgeStatus connected on Asterisk 13.22.0
    const capsWithBridge = resolveGatewayCapabilities({
        ariStatus: { asteriskVersion: "13.22.0", asteriskRawVersion: "13.22.0" },
        pbxStatus: { asteriskVersion: "13.22.0" },
        configuredAnswerMode: "auto",
        sipBridgeStatus: { enabled: true, connected: true, available: true },
    });
    assert.strictEqual(capsWithBridge.supportsExternalMedia, false);
    assert.strictEqual(capsWithBridge.sipBridgeAvailable, true);
    assert.strictEqual(capsWithBridge.recommendedAnswerMode, "sip_bridge");
    assert.strictEqual(capsWithBridge.effectiveAnswerMode, "sip_bridge");
    assert.strictEqual(capsWithBridge.compatibleWithConfiguredMode, true);

    const capsWithoutBridge = resolveGatewayCapabilities({
        ariStatus: { asteriskVersion: "13.22.0" },
        pbxStatus: {},
        configuredAnswerMode: "auto",
        sipBridgeStatus: { enabled: true, connected: false, available: false },
    });
    assert.strictEqual(capsWithoutBridge.recommendedAnswerMode, "extension");
    assert.strictEqual(capsWithoutBridge.effectiveAnswerMode, "extension");

    // 2. call-state classification for @ariana-web-agent and SIP/ariana-bridge-sip-*
    assert.strictEqual(classifyChannel("Local/101@ariana-web-agent-000001;1"), "agent_leg");
    assert.strictEqual(classifyChannel("SIP/ariana-bridge-sip-00000042"), "bridge_leg");
    assert.strictEqual(classifyChannel("PJSIP/ariana-bridge-sip-00000001"), "bridge_leg");

    const tracker = new CallStateService();
    const lid = "1795099001.10";

    const dJoin = tracker.processEvent({
        event: "queuecallerjoin",
        linkedid: lid,
        uniqueid: lid,
        channel: "Local/001@simulador-cola-00000001;2",
        caller: "0991000001",
        callerName: "Paciente Bridge",
        queue: "650",
    });
    assert.strictEqual(dJoin.emit, true);
    assert.strictEqual(dJoin.call.primaryChannel, "Local/001@simulador-cola-00000001;2");

    const dRingWeb = tracker.processEvent({
        event: "agentcalled",
        linkedid: lid,
        uniqueid: lid,
        channel: "Local/001@simulador-cola-00000001;2",
        destChannel: "Local/101@ariana-web-agent-00000002;1",
        destExtension: "101",
        queue: "650",
    });
    assert.strictEqual(dRingWeb.call.targetExtension, "101");

    // When web-agent 25s Local leg ends or bridge dials 88xxxxxxxx, targetExtension stays 101 and call does not end
    const dDialBridge = tracker.processEvent({
        event: "dialbegin",
        linkedid: lid,
        uniqueid: lid,
        channel: "Local/001@simulador-cola-00000001;2",
        destChannel: "SIP/ariana-bridge-sip-00000099",
        destExtension: "8812345678",
    });
    assert.strictEqual(dDialBridge.emit, false);
    assert.strictEqual(dDialBridge.reason, "bridge_leg_dial_ignored");
    assert.strictEqual(dDialBridge.call.targetExtension, "101");

    const dNewBridgeChan = tracker.processEvent({
        event: "newchannel",
        linkedid: lid,
        uniqueid: "1795099001.25",
        channel: "SIP/ariana-bridge-sip-00000099",
    });
    assert.strictEqual(dNewBridgeChan.call.primaryChannel, "Local/001@simulador-cola-00000001;2");

    const dBridgeEnter = tracker.processEvent({
        event: "bridgeenter",
        linkedid: lid,
        uniqueid: lid,
        channel: "Local/001@simulador-cola-00000001;2",
        destChannel: "SIP/ariana-bridge-sip-00000099",
        destExtension: "8812345678",
        bridgeNumChannels: 2,
    });
    assert.strictEqual(dBridgeEnter.emit, true);
    assert.strictEqual(dBridgeEnter.dedupeKey, `ANSWERED:${lid}`);
    assert.strictEqual(dBridgeEnter.call.targetExtension, "101");

    const dBridgeHangup = tracker.processEvent({
        event: "hangup",
        linkedid: lid,
        uniqueid: "1795099001.25",
        channel: "SIP/ariana-bridge-sip-00000099",
        cause: "16",
    });
    assert.strictEqual(dBridgeHangup.emit, false);
    assert.strictEqual(dBridgeHangup.reason, "subchannel_hangup_ignored");

    const dPrimaryHangup = tracker.processEvent({
        event: "hangup",
        linkedid: lid,
        uniqueid: lid,
        channel: "Local/001@simulador-cola-00000001;2",
        cause: "16",
    });
    assert.strictEqual(dPrimaryHangup.emit, true);
    assert.strictEqual(dPrimaryHangup.isTerminal, true);
    assert.strictEqual(dPrimaryHangup.call.status, "ENDED");

    // 2b. Regression: primaryCallChannel must select live caller channel (Local/...@simulador-cola;2 or SIP trunk)
    // and NEVER select expired/ringing SIP/101 agent legs dialed by Queue 650.
    const simCall = {
        linkedid: "1795029061.6043",
        channels: [
            "Local/001@simulador-cola-0000020f;2",
            "SIP/101-00000015",
            "SIP/101-00000016",
        ],
        events: [
            { event: "queuecallerjoin", channel: "Local/001@simulador-cola-0000020f;2" },
            { event: "agentcalled", channel: "Local/001@simulador-cola-0000020f;2", destChannel: "SIP/101-00000015" },
            { event: "hangup", channel: "SIP/101-00000015" },
            { event: "dialbegin", channel: "Local/001@simulador-cola-0000020f;2", destChannel: "SIP/101-00000016" },
        ],
    };
    assert.strictEqual(
        pbxService.__test.primaryCallChannel(simCall),
        "Local/001@simulador-cola-0000020f;2",
        "primaryCallChannel must choose live caller leg over SIP/101 agent leg"
    );

    // Ensure CallStateService also keeps primaryChannel locked against subsequent agent Newchannel events
    const sipAgentTracker = new CallStateService();
    const sipLid = "1795029999.1";
    sipAgentTracker.processEvent({
        event: "queuecallerjoin",
        linkedid: sipLid,
        uniqueid: sipLid,
        channel: "Local/001@simulador-cola-00000210;2",
        queue: "650",
    });
    const afterAgentNewChan = sipAgentTracker.processEvent({
        event: "newchannel",
        linkedid: sipLid,
        uniqueid: "1795029999.9",
        channel: "SIP/101-00000015",
    });
    assert.strictEqual(afterAgentNewChan.call.primaryChannel, "Local/001@simulador-cola-00000210;2");

    // 3. Bridge token resolution inside ari-bridge.service
    ariBridgeService.__test.clearTokens();
    const token = ariBridgeService.registerBridgeToken("1795099888.1", { agentId: 7 });
    assert.match(token, /^88\d{8}$/);

    await ariBridgeService.ingestEventForTest({
        type: "StasisStart",
        timestamp: new Date().toISOString(),
        application: "ariana-bridge",
        args: [token],
        channel: {
            id: "bridge-chan-1",
            name: "PJSIP/from-pbx-00000001",
            state: "Ring",
            caller: { number: "0991000001", name: "Paciente Bridge" },
            dialplan: { context: "from-pbx", exten: token, priority: 3 },
            linkedid: "9999999.1",
        },
    });

    const bridgeSession = ariBridgeService.getSessionByLinkedId("1795099888.1");
    assert.ok(bridgeSession, "ariBridgeService should resolve Issabel linkedid via token");
    assert.strictEqual(bridgeSession.channelId, "bridge-chan-1");
    assert.strictEqual(bridgeSession.inStasis, true);

    // 4. End-to-end mocked sip_bridge startMediaSessionByLinkedId + closeMediaSession
    const origEnv = {
        pbxAnswerMode: env.pbxAnswerMode,
        sipBridgeEnabled: env.sipBridgeEnabled,
        sipBridgeAriBaseUrl: env.sipBridgeAriBaseUrl,
        sipBridgeAriUsername: env.sipBridgeAriUsername,
        sipBridgeAriPassword: env.sipBridgeAriPassword,
        sipBridgeAriAppName: env.sipBridgeAriAppName,
        sipBridgeDialContext: env.sipBridgeDialContext,
        sipBridgeRtpHost: env.sipBridgeRtpHost,
        sipBridgeWaitMs: env.sipBridgeWaitMs,
    };
    const origBridgeGetStatus = ariBridgeService.getStatus;
    const origBridgeIsAvailable = ariBridgeService.isAvailable;
    const origBridgeAriRequest = ariBridgeService.ariRequest;
    const origBridgeAnswer = ariBridgeService.answerCallByLinkedId;
    const origBridgeEnsure = ariBridgeService.ensureCallBridgeByLinkedId;
    const origBridgeHangup = ariBridgeService.hangupSession;
    const origRedirectToBridge = pbxService.redirectCallToBridge;
    const origAriGetStatus = ariService.getStatus;

    const apiCalls = [];
    const targetLid = "1795099777.5";

    try {
        env.pbxAnswerMode = "auto";
        env.sipBridgeEnabled = true;
        env.sipBridgeAriAppName = "ariana-bridge";
        env.sipBridgeDialContext = "ariana-sip-bridge";
        env.sipBridgeRtpHost = "127.0.0.1";
        env.sipBridgeWaitMs = 2000;

        ariService.getStatus = () => ({
            enabled: true,
            connected: true,
            asteriskVersion: "13.22.0",
            asteriskRawVersion: "13.22.0",
            supportsExternalMedia: false,
        });
        ariBridgeService.getStatus = () => ({
            enabled: true,
            connected: true,
            available: true,
            asteriskVersion: "20.11.0",
            dialContext: "ariana-sip-bridge",
        });
        ariBridgeService.isAvailable = () => true;

        pbxService.redirectCallToBridge = async (_linkedid, issuedToken, dialContext) => {
            assert.match(issuedToken, /^88\d{8}$/);
            assert.strictEqual(dialContext, "ariana-sip-bridge");
            setImmediate(async () => {
                await ariBridgeService.ingestEventForTest({
                    type: "StasisStart",
                    timestamp: new Date().toISOString(),
                    application: "ariana-bridge",
                    args: [issuedToken],
                    channel: {
                        id: "bridge-chan-e2e",
                        name: "PJSIP/from-pbx-00000002",
                        state: "Ring",
                        dialplan: { context: "from-pbx", exten: issuedToken, priority: 3 },
                        linkedid: "bridge-pbx-2",
                    },
                });
            });
            return { channel: "SIP/trunk-0001", context: dialContext, extension: issuedToken };
        };

        ariBridgeService.answerCallByLinkedId = async (linkedid) => {
            apiCalls.push(["bridge.answer", linkedid]);
            return { channelId: "bridge-chan-e2e", status: "answered" };
        };

        ariBridgeService.ensureCallBridgeByLinkedId = async (linkedid) => {
            apiCalls.push(["bridge.ensureBridge", linkedid]);
            return { channelId: "bridge-chan-e2e", linkedid, bridgeId: "mix-bridge-1" };
        };

        ariBridgeService.ariRequest = async (method, reqPath, opts = {}) => {
            apiCalls.push(["bridge.ariRequest", method.toLowerCase(), reqPath, opts]);
            if (method.toLowerCase() === "post" && reqPath === "/channels/externalMedia") {
                assert.strictEqual(opts.params.app, "ariana-bridge");
                assert.ok(opts.params.external_host.startsWith("127.0.0.1:"));
                return { data: { id: "UnicastRTP/127.0.0.1:18002-0x1" } };
            }
            if (reqPath.endsWith("/variable") && opts.params?.variable === "UNICASTRTP_LOCAL_ADDRESS") {
                return { data: { value: "127.0.0.1" } };
            }
            if (reqPath.endsWith("/variable") && opts.params?.variable === "UNICASTRTP_LOCAL_PORT") {
                return { data: { value: "18002" } };
            }
            return { data: {} };
        };

        ariBridgeService.hangupSession = async (channelId, reason) => {
            apiCalls.push(["bridge.hangupSession", channelId, reason]);
            return { channelId, status: "ended" };
        };

        const started = await ariMediaService.startMediaSessionByLinkedId(targetLid, {
            owner: "agent",
            agentId: 12,
        });

        assert.strictEqual(started.transport, "sip_bridge");
        assert.strictEqual(started.ariAppName, "ariana-bridge");
        assert.strictEqual(started.bridgeId, "mix-bridge-1");
        assert.strictEqual(started.externalChannelId, "UnicastRTP/127.0.0.1:18002-0x1");
        assert.strictEqual(started.remoteRtp.address, "127.0.0.1");
        assert.strictEqual(started.remoteRtp.port, 18002);

        const closed = await ariMediaService.closeMediaSession(targetLid, "laravel_agent_12_hangup");
        assert.strictEqual(closed.status, "closed");
        assert.ok(
            apiCalls.some((c) => c[0] === "bridge.ariRequest" && c[1] === "delete" && c[2].includes("UnicastRTP")),
            "Must delete ExternalMedia channel on bridge ARI"
        );
        assert.ok(
            apiCalls.some((c) => c[0] === "bridge.hangupSession" && c[1] === "bridge-chan-e2e"),
            "Must hangup bridge SIP leg on explicit close"
        );
    } finally {
        ariMediaService.__test.resetMediaSessions();
        Object.assign(env, origEnv);
        ariService.getStatus = origAriGetStatus;
        ariBridgeService.getStatus = origBridgeGetStatus;
        ariBridgeService.isAvailable = origBridgeIsAvailable;
        ariBridgeService.ariRequest = origBridgeAriRequest;
        ariBridgeService.answerCallByLinkedId = origBridgeAnswer;
        ariBridgeService.ensureCallBridgeByLinkedId = origBridgeEnsure;
        ariBridgeService.hangupSession = origBridgeHangup;
        pbxService.redirectCallToBridge = origRedirectToBridge;
    }

    console.log("v2 sip-bridge unit & lifecycle tests passed");
}

run().catch((error) => {
    console.error("v2 sip-bridge test failed:", error);
    process.exit(1);
});

