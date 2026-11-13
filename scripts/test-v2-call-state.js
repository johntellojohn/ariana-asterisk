const assert = require("assert");
const { CallStateService, classifyChannel } = require("../src/modules/pbx/call-state.service");
const { QueuePresenceService } = require("../src/modules/pbx/queue-presence.service");

async function run() {
    // 1. Channel classification
    assert.strictEqual(classifyChannel("UnicastRTP/192.168.100.60:46000-001"), "internal_media");
    assert.strictEqual(classifyChannel("Local/101@from-queue-00000010;1"), "agent_leg");
    assert.strictEqual(classifyChannel("Local/101@simulador-agente-00000010;1"), "agent_leg");
    assert.strictEqual(classifyChannel("Local/0991000002@simulador-cola-00000001;2"), "caller_leg");
    assert.strictEqual(classifyChannel("SIP/trunk_issabel-00000044"), "trunk_or_sip");
    assert.strictEqual(classifyChannel("PJSIP/101-00000001"), "trunk_or_sip");

    // 2. Burst simulator queue abandonment + noise filtering + zero zombie pending
    const state = new CallStateService();
    const lid = "1794605163.99";
    const callerChannel = "Local/0991000002@simulador-cola-00000002;2";
    const agentChannel = "Local/101@simulador-agente-00000002;1";

    const emitted = [];
    const feed = (ev) => {
        const res = state.processEvent({ linkedid: lid, timestamp: ev.timestamp || "2026-11-13T16:30:00.000Z", ...ev });
        if (res.emit) emitted.push(res);
        return res;
    };

    feed({ event: "Newchannel", channel: callerChannel, caller: "0991000002", callerIdNum: "0991000002" });
    feed({ event: "VarSet", channel: callerChannel, variable: "MIXMONITOR_FILENAME", value: "x.wav" });
    feed({ event: "Newexten", channel: callerChannel });
    feed({ event: "QueueCallerJoin", channel: callerChannel, queue: "650", callerIdNum: "0991000002", timestamp: "2026-11-13T16:30:01.000Z" });
    feed({ event: "AgentCalled", channel: callerChannel, destChannel: agentChannel, queue: "650", timestamp: "2026-11-13T16:30:02.000Z" });
    // Redundant ring noise
    feed({ event: "DialBegin", channel: callerChannel, destChannel: agentChannel, destExtension: "101" });
    feed({ event: "RTCPSent", channel: agentChannel });
    // Agent leg timeout does NOT terminate call!
    const agentCancel = feed({ event: "DialEnd", channel: callerChannel, destChannel: agentChannel, dialStatus: "CANCEL" });
    assert.strictEqual(agentCancel.isTerminal, false);
    const agentHangup = feed({ event: "Hangup", channel: agentChannel });
    assert.strictEqual(agentHangup.isTerminal, false);
    assert.strictEqual(state.getCall(lid).status, "RINGING");

    // Caller hangs up on Local simulador-cola primary channel -> MUST be terminal!
    const callerHangup = feed({
        event: "Hangup",
        channel: callerChannel,
        cause: "16",
        causeTxt: "Normal Clearing",
        timestamp: "2026-11-13T16:30:08.000Z",
    });
    assert.strictEqual(callerHangup.emit, true);
    assert.strictEqual(callerHangup.isTerminal, true);
    assert.strictEqual(callerHangup.call.status, "ABANDONED");
    assert.strictEqual(callerHangup.timing.queueJoinedAt, "2026-11-13T16:30:01.000Z");
    assert.strictEqual(callerHangup.timing.ringStartedAt, "2026-11-13T16:30:02.000Z");
    assert.strictEqual(callerHangup.timing.answeredAt, null);
    assert.strictEqual(callerHangup.timing.endedAt, "2026-11-13T16:30:08.000Z");

    // Verify monotonic invariant: late events after terminal MUST NOT emit or revive
    const lateJoin = feed({ event: "QueueCallerJoin", channel: callerChannel, queue: "650" });
    assert.strictEqual(lateJoin.emit, false);
    assert.strictEqual(state.getCall(lid).status, "ABANDONED");

    // Only 3 clean emissions (INCOMING queue join, RING 101 update, TERMINAL ABANDONED) instead of 17!
    assert.strictEqual(emitted.length, 3);

    // 3. Answered SIP trunk call wait vs talk timing
    const state2 = new CallStateService();
    const lid2 = "1794606000.12";
    const trunkChan = "SIP/telco-000001";
    const sipAgent = "PJSIP/102-000002";

    state2.processEvent({ linkedid: lid2, event: "Newchannel", channel: trunkChan, callerIdNum: "099888777", timestamp: "2026-11-13T17:00:00.000Z" });
    state2.processEvent({ linkedid: lid2, event: "QueueCallerJoin", channel: trunkChan, queue: "650", callerIdNum: "099888777", timestamp: "2026-11-13T17:00:01.000Z" });
    state2.processEvent({ linkedid: lid2, event: "AgentCalled", channel: trunkChan, destChannel: sipAgent, queue: "650", timestamp: "2026-11-13T17:00:04.000Z" });

    // Stasis redirect defer flag prevents premature hangup during queue->Stasis bridge handoff
    state2.markStasisRedirectPending(lid2, 5000);
    const deferredHangup = state2.processEvent({ linkedid: lid2, event: "Hangup", channel: trunkChan });
    assert.strictEqual(deferredHangup.emit, false);
    assert.strictEqual(deferredHangup.reason, "stasis_redirect_in_progress");
    state2.clearStasisRedirectPending(lid2);

    const ans = state2.processEvent({ linkedid: lid2, event: "AgentConnect", channel: trunkChan, destChannel: sipAgent, timestamp: "2026-11-13T17:00:12.000Z" });
    assert.strictEqual(ans.emit, true);
    assert.strictEqual(ans.call.status, "ANSWERED");
    assert.strictEqual(ans.timing.answeredAt, "2026-11-13T17:00:12.000Z");

    const done = state2.processEvent({ linkedid: lid2, event: "Hangup", channel: trunkChan, timestamp: "2026-11-13T17:02:12.000Z" });
    assert.strictEqual(done.isTerminal, true);
    assert.strictEqual(done.call.status, "ENDED");
    assert.strictEqual(done.timing.endedAt, "2026-11-13T17:02:12.000Z");

    // TTL GC cleans old ended calls
    const c2 = state2.getCall(lid2);
    c2.updatedAtMs = Date.now() - 20 * 60 * 1000;
    const pruned = state2.pruneStaleCalls();
    assert.strictEqual(pruned, 1);
    assert.strictEqual(state2.getCall(lid2), null);

    // 4. QueuePresenceService: QueueStatus discovery + delta-only QueuePause
    const presence = new QueuePresenceService();
    const amiCalls = [];
    const mockAmi = async (action) => {
        amiCalls.push(action);
        return { Response: "Success" };
    };
    const mockFetchStatus = async () => ({
        events: [
            { Event: "QueueMember", Queue: "650", Name: "101", Location: "Local/101@simulador-agente/n" },
            { Event: "QueueMember", Queue: "650", Name: "102", Location: "PJSIP/102" },
        ],
    });

    const firstSync = await presence.syncDelta({
        queue: "650",
        onlineExtensions: ["101"],
        allExtensions: ["101", "102"],
        runAmiAction: mockAmi,
        fetchQueueStatus: mockFetchStatus,
    });
    assert.strictEqual(firstSync.changedCount, 2);
    assert.strictEqual(firstSync.skippedCount, 0);
    assert.strictEqual(amiCalls[0].Interface, "Local/101@simulador-agente/n");
    assert.strictEqual(amiCalls[0].Paused, "false");
    assert.strictEqual(amiCalls[1].Interface, "PJSIP/102");
    assert.strictEqual(amiCalls[1].Paused, "true");

    // Second identical sync -> 0 AMI QueuePause calls!
    const countBeforeSecond = amiCalls.length;
    const secondSync = await presence.syncDelta({
        queue: "650",
        onlineExtensions: ["101"],
        allExtensions: ["101", "102"],
        runAmiAction: mockAmi,
        fetchQueueStatus: mockFetchStatus,
    });
    assert.strictEqual(secondSync.changedCount, 0);
    assert.strictEqual(secondSync.skippedCount, 2);
    assert.strictEqual(amiCalls.length, countBeforeSecond);

    // Extension 101 goes busy in local media call -> pauses ONLY 101
    const thirdSync = await presence.syncDelta({
        queue: "650",
        onlineExtensions: ["101"],
        allExtensions: ["101", "102"],
        isExtensionBusy: (ext) => ext === "101",
        runAmiAction: mockAmi,
        fetchQueueStatus: mockFetchStatus,
    });
    assert.strictEqual(thirdSync.changedCount, 1);
    assert.strictEqual(thirdSync.skippedCount, 1);
    assert.strictEqual(amiCalls[amiCalls.length - 1].Interface, "Local/101@simulador-agente/n");
    assert.strictEqual(amiCalls[amiCalls.length - 1].Paused, "true");

    console.log("v2 call-state & queue-presence tests passed");
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});

