const assert = require("assert");

const env = require("../src/config/env");
const ariAiSessionService = require("../src/modules/ari/ari-ai-session.service");
const ariMediaService = require("../src/modules/ari/ari-media.service");

function humanWebSocket() {
    return {
        readyState: 1,
        closeCalls: [],
        close(code, reason) {
            this.closeCalls.push({ code, reason });
            this.readyState = 3;
        },
    };
}

function recording() {
    return {
        finalized: false,
        agentId: null,
        participantTransitions: [],
        async finalize() {
            this.finalized = true;
        },
        addParticipantTransition(transition) {
            this.participantTransitions.push(transition);
        },
    };
}

function registerHumanMediaSession(linkedid, ws, recorder, id = `media-${linkedid}`) {
    const session = {
        id,
        linkedid,
        owner: "agent",
        channelId: `channel-${linkedid}`,
        bridgeId: `bridge-${linkedid}`,
        status: "agent_connected",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        closedAt: null,
        closeReason: null,
        externalChannelId: `external-${linkedid}`,
        rtpHost: "127.0.0.1",
        rtpBindHost: "0.0.0.0",
        rtpPort: 46000,
        remoteRtp: { address: "127.0.0.1", port: 18000 },
        rtpPacketsReceived: 10,
        rtpPacketsSent: 10,
        rtpSendQueue: [Buffer.from([1])],
        rtpSendTimer: null,
        agentFramesReceived: 5,
        browserFramesSent: 5,
        activeAgentId: 77,
        aiAgentId: null,
        lastTransferId: null,
        agentWebSocketUrl: `ws://test/${linkedid}`,
        agentWebSocketPath: `/test/${linkedid}`,
        agentWs: ws,
        codecState: {},
        recording: recorder,
        onAsteriskPcm48: null,
        onClose: null,
        lastError: null,
    };

    ariMediaService.__test.registerMediaSession(session);

    return session;
}

async function testSlowOldCloseDoesNotDeleteReplacementMediaSession() {
    ariAiSessionService.__test.resetAiSessions();
    ariMediaService.__test.resetMediaSessions();

    const linkedid = "linked-media-replacement";
    const oldWs = humanWebSocket();
    const oldRecorder = recording();
    let releaseFinalize;
    let markFinalizeStarted;
    const finalizeStarted = new Promise((resolve) => {
        markFinalizeStarted = resolve;
    });
    const finalizeReleased = new Promise((resolve) => {
        releaseFinalize = resolve;
    });

    oldRecorder.finalize = async function finalize() {
        markFinalizeStarted();
        await finalizeReleased;
        this.finalized = true;
    };

    const oldSession = registerHumanMediaSession(
        linkedid,
        oldWs,
        oldRecorder,
        "media-old-replacement"
    );
    oldSession.externalChannelId = null;
    const closing = ariMediaService.closeMediaSession(oldSession.id, "human_transfer_started");

    await finalizeStarted;

    const replacementWs = humanWebSocket();
    const replacementRecorder = recording();
    const replacement = registerHumanMediaSession(
        linkedid,
        replacementWs,
        replacementRecorder,
        "media-new-replacement"
    );

    releaseFinalize();
    await closing;

    const current = ariMediaService.getMediaSession(linkedid);

    assert.strictEqual(current.id, replacement.id);
    assert.strictEqual(current.owner, "agent");
    assert.strictEqual(current.hasAgentWebSocket, true);
    assert.strictEqual(replacementWs.closeCalls.length, 0);
}

async function testHumanRemainsConnectedUntilRealtimeIsReady() {
    const linkedid = "linked-human-to-ai";
    const ws = humanWebSocket();
    const recorder = recording();

    registerHumanMediaSession(linkedid, ws, recorder);
    ariAiSessionService.__test.setConnectRealtime(async (session) => {
        assert.strictEqual(ws.closeCalls.length, 0, "human must remain connected while AI prepares");
        session.realtimeSocket = { readyState: 1, close() {} };
        session.realtimeReady = true;
        session.status = "realtime_ready";
    });

    const result = await ariAiSessionService.activateAiSessionByLinkedId(linkedid, {
        transfer_id: "transfer-1",
        agent_id: 25,
        tools_base_url: "https://eva.test/api/voice-agent/tools",
        handoff_context: "El cliente ya confirmo su identidad y necesita reagendar.",
        handoff_greeting: "Hola, continuare ayudandote con tu solicitud.",
        realtime: {
            model: "gpt-realtime",
            voice: "coral",
            instructions: "Eres el agente seleccionado.",
        },
    });

    const media = ariMediaService.getMediaSession(linkedid);

    assert.strictEqual(result.status, "active");
    assert.strictEqual(result.agentId, 25);
    assert.strictEqual(result.hasHandoffContext, true);
    assert.strictEqual(media.owner, "ai");
    assert.strictEqual(media.aiAgentId, 25);
    assert.strictEqual(media.hasAgentWebSocket, false);
    assert.deepStrictEqual(ws.closeCalls, [{ code: 1000, reason: "transferred_to_ai" }]);
    assert.strictEqual(recorder.finalized, false);
    assert.strictEqual(recorder.agentId, 25);
    assert.strictEqual(recorder.participantTransitions.length, 1);
    assert.strictEqual(recorder.participantTransitions[0].from_id, 77);
    assert.strictEqual(recorder.participantTransitions[0].to_id, 25);

    const duplicate = await ariAiSessionService.activateAiSessionByLinkedId(linkedid, {
        transfer_id: "transfer-1",
        agent_id: 25,
    });

    assert.strictEqual(duplicate.id, result.id);
    assert.strictEqual(recorder.participantTransitions.length, 1);
}

async function testRealtimeFailureKeepsHumanConnected() {
    ariAiSessionService.__test.resetAiSessions();
    ariMediaService.__test.resetMediaSessions();

    const linkedid = "linked-human-to-ai-failure";
    const ws = humanWebSocket();
    const recorder = recording();

    registerHumanMediaSession(linkedid, ws, recorder);
    ariAiSessionService.__test.setConnectRealtime(async () => {
        throw new Error("OpenAI unavailable");
    });

    await assert.rejects(
        () => ariAiSessionService.activateAiSessionByLinkedId(linkedid, {
            transfer_id: "transfer-failure",
            agent_id: 25,
            realtime: { instructions: "Nuevo agente" },
        }),
        /OpenAI unavailable/
    );

    const media = ariMediaService.getMediaSession(linkedid);

    assert.strictEqual(media.owner, "agent");
    assert.strictEqual(media.activeAgentId, 77);
    assert.strictEqual(media.hasAgentWebSocket, true);
    assert.strictEqual(ws.closeCalls.length, 0);
    assert.strictEqual(recorder.participantTransitions.length, 0);
}

function testHandoffContextIsIncludedInRealtimeInstructions() {
    const session = ariAiSessionService.__test.createAiSession("linked-context", {
        handoff_context: "Cliente confirmo su cedula y falta reagendar.",
    });
    const config = ariAiSessionService.__test.sessionConfig(session);

    assert.match(config.instructions, /Cliente confirmo su cedula/);
    assert.match(config.instructions, /Continua desde este punto/);
    assert.match(config.instructions, /No vuelvas a pedir datos/);
}

async function main() {
    env.trunkAiEnabled = true;
    env.openaiApiKey = env.openaiApiKey || "test-openai-key";

    try {
        await testSlowOldCloseDoesNotDeleteReplacementMediaSession();
        await testHumanRemainsConnectedUntilRealtimeIsReady();
        await testRealtimeFailureKeepsHumanConnected();
        testHandoffContextIsIncludedInRealtimeInstructions();
        console.log("trunk human to AI transfer tests passed");
    } finally {
        ariAiSessionService.__test.resetConnectRealtime();
        ariAiSessionService.__test.resetAiSessions();
        ariMediaService.__test.resetMediaSessions();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
