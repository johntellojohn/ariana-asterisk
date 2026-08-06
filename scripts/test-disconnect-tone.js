const assert = require("assert");

const aiService = require("../src/modules/ari/ari-ai-session.service");
const laravelService = require("../src/modules/laravel/laravel.service");
const pbxService = require("../src/modules/pbx/pbx.service");

const SAMPLE_RATE = 48000;
const FRAME_MS = 20;

function audioFrame(frequency = null, amplitude = 0.25) {
    const sampleCount = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
    const buffer = Buffer.alloc(sampleCount * 2);

    for (let index = 0; index < sampleCount; index += 1) {
        const value = frequency
            ? Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE) * amplitude
            : 0;
        buffer.writeInt16LE(Math.round(value * 32767), index * 2);
    }

    return buffer;
}

function speechFrame(at, level) {
    return { at, durationMs: FRAME_MS, level };
}

function detectorSession(linkedid) {
    const session = aiService.__test.createAiSession(linkedid);
    session.outputFramesSent = 1;
    return session;
}

function feed(session, buffer, frameCount, level, startAt) {
    let result = { shouldClose: false };
    let at = startAt;

    for (let index = 0; index < frameCount; index += 1) {
        result = aiService.__test.trackDisconnectTone(
            session,
            buffer,
            speechFrame(at, level)
        );
        at += FRAME_MS;
    }

    return { result, at };
}

function testCadenceClosesAfterTwoQualifiedBursts() {
    const session = detectorSession("cadence-qualified");
    const tone = audioFrame(425);
    const silence = audioFrame();
    let at = Date.now();

    ({ at } = feed(session, tone, 16, 0.18, at));
    ({ at } = feed(session, silence, 12, 0, at));
    const { result } = feed(session, tone, 16, 0.18, at);

    assert.strictEqual(result.shouldClose, true);
    assert.strictEqual(result.reason.detection, "cadence");
    assert.strictEqual(result.reason.bursts, 2);
    assert.strictEqual(result.reason.frequency, 425);
}

function testShortPulsesDoNotClose() {
    const session = detectorSession("cadence-short-pulses");
    const tone = audioFrame(425);
    const silence = audioFrame();
    let at = Date.now();
    let result = { shouldClose: false };

    for (let pulse = 0; pulse < 5; pulse += 1) {
        ({ at, result } = feed(session, tone, 5, 0.18, at));
        ({ at, result } = feed(session, silence, 10, 0, at));
    }

    assert.strictEqual(result.shouldClose, false);
    assert.strictEqual(session.disconnectToneBursts, 0);
}

function testSustainedToneFallbackStillCloses() {
    const session = detectorSession("sustained-fallback");
    const tone = audioFrame(425);
    const { result } = feed(session, tone, 90, 0.18, Date.now());

    assert.strictEqual(result.shouldClose, true);
    assert.strictEqual(result.reason.detection, "sustained");
    assert.strictEqual(result.reason.toneMs, 1800);
}

async function testCloseCallbackAndPbxHangupAreIdempotent() {
    const originalCallback = laravelService.sendTrunkCallEvent;
    const originalHangup = pbxService.hangupCall;
    const callbacks = [];
    const hangups = [];

    try {
        laravelService.sendTrunkCallEvent = async (payload) => {
            callbacks.push(payload);
        };
        pbxService.hangupCall = async (...args) => {
            hangups.push(args);
        };

        const session = aiService.__test.createAiSession("callback-idempotent", {
            tenant: "tenant_test",
            callback_url: "https://eva.test/api/trunk-calls/events",
        });
        aiService.__test.registerAiSession(session);

        aiService.__test.closeAfterDisconnectTone(session, { detection: "cadence" });
        aiService.__test.closeAfterDisconnectTone(session, { detection: "cadence" });
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.strictEqual(callbacks.length, 1);
        assert.strictEqual(callbacks[0].tenant, "tenant_test");
        assert.strictEqual(callbacks[0].event.event, "ended");
        assert.strictEqual(callbacks[0].event.linkedid, "callback-idempotent");
        assert.strictEqual(callbacks[0].event.reason, "disconnect_tone_detected");
        assert.strictEqual(hangups.length, 1);
        assert.deepStrictEqual(hangups[0], ["callback-idempotent", "disconnect_tone_detected"]);
    } finally {
        laravelService.sendTrunkCallEvent = originalCallback;
        pbxService.hangupCall = originalHangup;
        aiService.__test.resetAiSessions();
    }
}

async function run() {
    testCadenceClosesAfterTwoQualifiedBursts();
    testShortPulsesDoNotClose();
    testSustainedToneFallbackStillCloses();
    await testCloseCallbackAndPbxHangupAreIdempotent();
    console.log("disconnect tone tests passed");
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
