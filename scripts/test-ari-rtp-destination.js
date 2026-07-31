const assert = require("assert");

const env = require("../src/config/env");
const ariMediaService = require("../src/modules/ari/ari-media.service");

async function resolvesChannelVariables() {
    const session = {
        linkedid: "linked-rtp-vars",
        externalChannelId: "external/channel 1",
        remoteRtp: null,
        lastError: "previous error",
    };
    const requests = [];
    const request = async (method, path, options) => {
        requests.push({ method, path, variable: options.params.variable });

        return {
            data: {
                value: options.params.variable === "UNICASTRTP_LOCAL_ADDRESS"
                    ? "192.168.100.10"
                    : "18746",
            },
        };
    };

    const destination = await ariMediaService.__test.resolveAsteriskRtpDestination(session, request);

    assert.deepStrictEqual(destination, { address: "192.168.100.10", port: 18746 });
    assert.deepStrictEqual(session.remoteRtp, destination);
    assert.strictEqual(session.remoteRtpSource, "channel_variables");
    assert.strictEqual(session.lastError, null);
    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[0].path, "/channels/external%2Fchannel%201/variable");
}

async function retriesWhileVariablesInitialize() {
    const session = {
        linkedid: "linked-rtp-retry",
        externalChannelId: "external-retry",
    };
    let requests = 0;
    const request = async (_method, _path, options) => {
        requests += 1;
        const attempt = Math.ceil(requests / 2);

        return {
            data: {
                value: attempt === 1
                    ? ""
                    : (options.params.variable === "UNICASTRTP_LOCAL_ADDRESS" ? "10.0.0.5" : "19000"),
            },
        };
    };

    const destination = await ariMediaService.__test.resolveAsteriskRtpDestination(session, request);

    assert.deepStrictEqual(destination, { address: "10.0.0.5", port: 19000 });
    assert.strictEqual(requests, 4);
}

async function reportsUnavailableVariablesForFallback() {
    const session = {
        linkedid: "linked-rtp-fallback",
        externalChannelId: "external-fallback",
        remoteRtp: null,
    };
    const request = async () => ({ data: { value: "" } });

    await assert.rejects(
        () => ariMediaService.__test.resolveAsteriskRtpDestination(session, request),
        /Unable to resolve Asterisk RTP destination/
    );
    assert.strictEqual(session.remoteRtp, null);
}

function boundsRtpQueueForRealtime() {
    const previousFrameMs = env.ariExternalMediaFrameMs;
    const previousMaxQueueMs = env.ariExternalMediaMaxQueueMs;
    const session = {
        linkedid: "linked-rtp-latency",
        rtpSendQueue: [],
        rtpPacketsDroppedLatency: 0,
    };

    env.ariExternalMediaFrameMs = 20;
    env.ariExternalMediaMaxQueueMs = 200;

    try {
        const payloads = Array.from({ length: 15 }, (_, index) => Buffer.from([index]));
        const dropped = ariMediaService.__test.enqueueRtpPayloads(session, payloads);

        assert.strictEqual(dropped, 5);
        assert.strictEqual(session.rtpSendQueue.length, 10);
        assert.strictEqual(session.rtpPacketsDroppedLatency, 5);
        assert.strictEqual(session.rtpSendQueue[0][0], 5, "oldest audio must be discarded first");
        assert.strictEqual(session.rtpSendQueue[9][0], 14);
    } finally {
        env.ariExternalMediaFrameMs = previousFrameMs;
        env.ariExternalMediaMaxQueueMs = previousMaxQueueMs;
    }
}

async function main() {
    await resolvesChannelVariables();
    await retriesWhileVariablesInitialize();
    await reportsUnavailableVariablesForFallback();
    boundsRtpQueueForRealtime();
    console.log("ARI RTP destination tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
