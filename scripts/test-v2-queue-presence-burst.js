const assert = require("assert");
const { QueuePresenceService } = require("../src/modules/pbx/queue-presence.service");
const callState = require("../src/modules/pbx/call-state.service");
const pbxService = require("../src/modules/pbx/pbx.service");

async function run() {
    // 1. Exact reproduction of the burst rotation bug:
    // Call rings 101 (no answer), rotates to 150, 150 answers -> ONLY 150 is locally busy, NEVER 101!
    callState.reset();
    const lid = "1795529800.100";
    callState.processEvent({
        event: "queuecallerjoin",
        linkedid: lid,
        channel: "Local/001@simulador-cola-00000010;2",
        queue: "650",
        callerIdNum: "0991000001",
    });
    callState.processEvent({
        event: "agentcalled",
        linkedid: lid,
        channel: "Local/001@simulador-cola-00000010;2",
        destChannel: "Local/101@ariana-web-agent-00000011;1",
        destExtension: "101",
        queue: "650",
    });
    // While merely RINGING on 101 (not answered yet), sync must NOT falsely pause 101
    assert.strictEqual(pbxService.isExtensionBusyLocally("101"), false, "101 must not be marked locally busy while merely ringing");

    // Rotates to 150 and 150 answers
    callState.processEvent({
        event: "agentcalled",
        linkedid: lid,
        channel: "Local/001@simulador-cola-00000010;2",
        destChannel: "Local/150@ariana-web-agent-00000012;1",
        destExtension: "150",
        queue: "650",
    });
    callState.processEvent({
        event: "agentconnect",
        linkedid: lid,
        channel: "Local/001@simulador-cola-00000010;2",
        destChannel: "Local/150@ariana-web-agent-00000012;1",
        destExtension: "150",
        queue: "650",
    });

    assert.strictEqual(pbxService.isExtensionBusyLocally("150"), true, "150 MUST be busy while answering");
    assert.strictEqual(
        pbxService.isExtensionBusyLocally("101"),
        false,
        "101 MUST remain free after call rotated from 101 -> 150 even though Local/101 is in call.channels"
    );

    // Run syncDelta while 150 is talking -> 101 MUST stay unpaused (Paused=false), 150 paused (Paused=true)
    const presence = new QueuePresenceService();
    const amiActions = [];
    const mockAmi = async (action) => {
        amiActions.push(action);
        return { Response: "Success" };
    };
    const mockQueueStatus = async () => ({
        events: [
            { Event: "QueueMember", Queue: "650", Name: "Lizeth", Location: "Local/101@ariana-web-agent/n", Paused: "0" },
            { Event: "QueueMember", Queue: "650", Name: "Nadia", Location: "Local/150@ariana-web-agent/n", Paused: "0" },
        ],
    });

    const syncDuringCall = await presence.syncDelta({
        queue: "650",
        onlineExtensions: ["101", "150"],
        allExtensions: ["101", "150"],
        isExtensionBusy: pbxService.isExtensionBusyLocally,
        runAmiAction: mockAmi,
        fetchQueueStatus: mockQueueStatus,
    });
    // Because QueueStatus reported both Paused:"0", ONLY 150 needs QueuePause(true); 101 is already unpaused -> skipped!
    assert.strictEqual(syncDuringCall.changedCount, 1, "Only 150 should be paused in AMI");
    assert.strictEqual(syncDuringCall.skippedCount, 1, "101 should be untouched (already unpaused)");
    assert.strictEqual(amiActions.length, 1);
    assert.strictEqual(amiActions[0].Interface, "Local/150@ariana-web-agent/n");
    assert.strictEqual(amiActions[0].Paused, "true");

    // 2. Idempotency across different reasons (3x paused=true + 4x paused=false -> ONLY 1 AMI call per state flip!)
    const idempPresence = new QueuePresenceService();
    const idempCalls = [];
    const idempAmi = async (action) => {
        idempCalls.push(action);
        return { Response: "Success" };
    };

    const p1 = await idempPresence.setMemberPaused({
        queue: "650",
        extension: "150",
        paused: true,
        reason: "in_call",
        runAmiAction: idempAmi,
        fetchQueueStatus: mockQueueStatus,
    });
    const p2 = await idempPresence.setMemberPaused({
        queue: "650",
        extension: "150",
        paused: true,
        reason: "trunk_answered",
        runAmiAction: idempAmi,
        fetchQueueStatus: mockQueueStatus,
    });
    const p3 = await idempPresence.setMemberPaused({
        queue: "650",
        extension: "150",
        paused: true,
        reason: "trunk_v2_answered",
        runAmiAction: idempAmi,
        fetchQueueStatus: mockQueueStatus,
    });
    assert.strictEqual(p1.skipped, false);
    assert.strictEqual(p2.skipped, true);
    assert.strictEqual(p3.skipped, true);
    assert.strictEqual(idempCalls.length, 1, "Duplicate pause calls with different reasons must not hit AMI again");

    const u1 = await idempPresence.setMemberPaused({
        queue: "650",
        extension: "150",
        paused: false,
        reason: "available",
        runAmiAction: idempAmi,
    });
    const u2 = await idempPresence.setMemberPaused({
        queue: "650",
        extension: "150",
        paused: false,
        reason: "call_ended",
        runAmiAction: idempAmi,
    });
    const u3 = await idempPresence.setMemberPaused({
        queue: "650",
        extension: "150",
        paused: false,
        reason: "agent_hangup",
        runAmiAction: idempAmi,
    });
    assert.strictEqual(u1.skipped, false);
    assert.strictEqual(u2.skipped, true);
    assert.strictEqual(u3.skipped, true);
    assert.strictEqual(idempCalls.length, 2, "Total AMI calls for full call lifecycle must be exactly 2 (1 pause + 1 unpause)");

    // Sync right after hangup with online_eva must NOT emit a redundant QueuePause when already unpaused
    const syncAfterHangup = await idempPresence.syncDelta({
        queue: "650",
        onlineExtensions: ["101", "150"],
        allExtensions: ["101", "150"],
        isExtensionBusy: () => false,
        runAmiAction: idempAmi,
        fetchQueueStatus: mockQueueStatus,
    });
    assert.strictEqual(syncAfterHangup.changedCount, 0, "Sync after hangup must skip already-unpaused members");
    assert.strictEqual(idempCalls.length, 2);

    // 3. Per-extension serialization: rapid pause(true) followed immediately by pause(false) MUST execute in strict FIFO order
    const serialPresence = new QueuePresenceService();
    const order = [];
    const slowAmi = async (action) => {
        const delay = action.Paused === "true" ? 40 : 5;
        await new Promise((r) => setTimeout(r, delay));
        order.push(action.Paused);
        return { Response: "Success" };
    };
    await Promise.all([
        serialPresence.setMemberPaused({ queue: "650", extension: "101", paused: true, reason: "in_call", runAmiAction: slowAmi }),
        serialPresence.setMemberPaused({ queue: "650", extension: "101", paused: false, reason: "available", runAmiAction: slowAmi }),
    ]);
    assert.deepStrictEqual(order, ["true", "false"], "Per-extension lock must preserve strict FIFO order even if first AMI call is slower");

    // 4. Drift auto-healing: if Asterisk QueueStatus reveals 101 was manually paused (Paused: "1"), syncDelta heals it to Paused="false"
    const healPresence = new QueuePresenceService();
    healPresence.stateByKey.set("650:101", "0");
    const healCalls = [];
    const healSync = await healPresence.syncDelta({
        queue: "650",
        onlineExtensions: ["101"],
        allExtensions: ["101"],
        runAmiAction: async (action) => {
            healCalls.push(action);
            return { Response: "Success" };
        },
        fetchQueueStatus: async () => ({
            events: [{ Event: "QueueMember", Queue: "650", Name: "Lizeth", Location: "Local/101@ariana-web-agent/n", Paused: "1" }],
        }),
    });
    assert.strictEqual(healSync.changedCount, 1, "Drift from live QueueStatus must be auto-healed");
    assert.strictEqual(healCalls[0].Paused, "false");

    callState.reset();
    console.log("PASS: test-v2-queue-presence-burst.js");
}

run().catch((err) => {
    console.error("FAIL: test-v2-queue-presence-burst.js", err);
    process.exit(1);
});

