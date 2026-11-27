const assert = require("assert");
const dgram = require("dgram");
const http = require("http");
const WebSocket = require("ws");

process.env.NODE_ENV = "test";
process.env.CALL_RECORDING_ENABLED = "false";
process.env.CALL_RECORDING_TRANSCRIBE = "false";
process.env.ARI_EXTERNAL_MEDIA_HOST = "127.0.0.1";
process.env.ARI_EXTERNAL_MEDIA_BIND_HOST = "127.0.0.1";
process.env.ARI_EXTERNAL_MEDIA_PORT_START = "46150";
process.env.ARI_EXTERNAL_MEDIA_PORT_END = "46180";
process.env.TRUNK_HUMAN_DISCONNECT_TONE_ENABLED = "false";

const ariService = require("../src/modules/ari/ari.service");
const { createAriClient } = require("../src/modules/ari/ari-client.factory");
const ariMediaService = require("../src/modules/ari/ari-media.service");
const { attachAriWebSocketServer } = require("../src/modules/ari/ari.websocket");
const {
    buildRtpPacket,
    parseRtpPacket,
    decodeUlaw,
    encodeUlaw,
    decodeUlawPayloadToPcm48,
    ulawBufferToPayloads,
} = require("../src/modules/ari/rtp-media");

function bindUdpPeer() {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket("udp4");
        sock.once("error", reject);
        sock.bind(0, "127.0.0.1", () => {
            sock.removeListener("error", reject);
            resolve(sock);
        });
    });
}

function testLinearInterpolationAndFraming() {
    const state = { prevUlawDecodeSample: null };
    const lowByte = encodeUlaw(0);
    const highByte = encodeUlaw(6000);
    const payload = Buffer.from([lowByte, highByte]);

    const pcm48Buf = decodeUlawPayloadToPcm48(payload, state);
    assert.strictEqual(pcm48Buf.length, 2 * 6 * 2, "2 ulaw samples => 12 PCM48 samples => 24 bytes");

    // Samples 6..11 interpolate smoothly from decoded(lowByte) to decoded(highByte)
    const s0 = pcm48Buf.readInt16LE(6 * 2);
    const s2 = pcm48Buf.readInt16LE(8 * 2);
    const s5 = pcm48Buf.readInt16LE(11 * 2);
    assert.ok(s0 > 0 && s2 > s0 && s5 > s2, `Expected strictly increasing linear ramp, got ${s0}, ${s2}, ${s5}`);
    assert.strictEqual(s5, decodeUlaw(highByte));
    assert.strictEqual(state.prevUlawDecodeSample, decodeUlaw(highByte));

    // Boundary continuity into next packet
    const nextBuf = decodeUlawPayloadToPcm48(Buffer.from([lowByte]), state);
    const firstNext = nextBuf.readInt16LE(0);
    assert.ok(firstNext > 0 && firstNext < s5, `Expected smooth ramp back down across packet boundary, got ${firstNext}`);

    // Arbitrary framing into exact 160-byte payloads
    const framingState = { ulawRemainder: Buffer.alloc(0) };
    const part1 = ulawBufferToPayloads(Buffer.alloc(100, 0xaa), framingState, 160);
    assert.strictEqual(part1.length, 0);
    assert.strictEqual(framingState.ulawRemainder.length, 100);

    const part2 = ulawBufferToPayloads(Buffer.alloc(240, 0xbb), framingState, 160);
    assert.strictEqual(part2.length, 2);
    assert.strictEqual(part2[0].length, 160);
    assert.strictEqual(part2[1].length, 160);
    assert.strictEqual(part2[0][0], 0xaa);
    assert.strictEqual(part2[0][100], 0xbb);
    assert.strictEqual(framingState.ulawRemainder.length, 20);
}

async function testWebSocketCodecNegotiation() {
    const peers = new Map();
    let seqCounter = 0;

    ariService.getSessionByLinkedId = (linkedid) => ({
        linkedid,
        channelId: `PJSIP/sim-${linkedid}`,
        bridgeId: `bridge-${linkedid}`,
        inStasis: true,
        answeredAt: new Date().toISOString(),
        status: "bridged",
        stasisArgs: [linkedid],
    });
    ariService.answerCallByLinkedId = async () => ({});
    ariService.stopMoh = async () => ({});
    ariService.ensureCallBridgeByLinkedId = async (linkedid) => ({
        linkedid,
        channelId: `PJSIP/sim-${linkedid}`,
        bridgeId: `bridge-${linkedid}`,
    });
    ariService.ariRequest = async (method, urlPath, config = {}) => {
        if (method === "post" && urlPath === "/channels/externalMedia") {
            const sock = await bindUdpPeer();
            const extId = `UnicastRTP/test-${++seqCounter}`;
            const [gwHost, gwPort] = String(config?.params?.external_host || "127.0.0.1:0").split(":");
            const peer = {
                extId,
                sock,
                port: sock.address().port,
                gwHost,
                gwPort: Number(gwPort),
                receivedPayloads: [],
            };
            sock.on("message", (pkt) => {
                const parsed = parseRtpPacket(pkt);
                if (parsed) {
                    peer.receivedPayloads.push(Buffer.from(parsed.payload));
                }
            });
            peers.set(extId, peer);
            return { data: { id: extId } };
        }
        if (method === "get" && urlPath.includes("/variable")) {
            const extId = decodeURIComponent(urlPath.split("/")[2]);
            const peer = peers.get(extId);
            const variable = config?.params?.variable;
            return {
                data: {
                    value: variable === "UNICASTRTP_LOCAL_ADDRESS" ? "127.0.0.1" : String(peer.port),
                },
            };
        }
        return { data: { ok: true } };
    };

    const server = http.createServer((_req, res) => {
        res.statusCode = 200;
        res.end("ok");
    });
    attachAriWebSocketServer(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
        // 1. Test negotiated ?codec=ulaw mode (160B frames + handshake)
        const ulawSession = await ariMediaService.startMediaSessionByLinkedId("linked-ulaw-1", {
            owner: "agent",
            agentId: "150",
            transcribeRecording: false,
        });
        const ulawPeer = peers.get(ulawSession.externalChannelId);
        const ulawWs = new WebSocket(`ws://127.0.0.1:${port}${ulawSession.agentWebSocketPath}&codec=ulaw`);

        const textMessages = [];
        const binaryMessages = [];
        await new Promise((resolve, reject) => {
            ulawWs.once("error", reject);
            ulawWs.on("message", (data, isBinary) => {
                if (!isBinary) {
                    textMessages.push(JSON.parse(data.toString()));
                } else {
                    binaryMessages.push(Buffer.from(data));
                }
            });
            ulawWs.once("open", resolve);
        });

        await new Promise((r) => setTimeout(r, 40));
        assert.strictEqual(textMessages.length, 1, "Expected 1 audio_config text frame");
        assert.strictEqual(textMessages[0].type, "audio_config");
        assert.strictEqual(textMessages[0].codec, "ulaw");
        assert.strictEqual(textMessages[0].sampleRate, 8000);
        assert.strictEqual(ariMediaService.getMediaSession("linked-ulaw-1").agentCodec, "ulaw");

        // Downlink: Asterisk sends 160B RTP -> browser receives exact 160B ulaw (NOT 1920B!)
        const sampleUlawPayload = Buffer.alloc(160, 0x55);
        const rtpPkt = buildRtpPacket(sampleUlawPayload, { sequence: 10, timestamp: 160, ssrc: 1234 });
        ulawPeer.sock.send(rtpPkt, ulawPeer.gwPort, ulawPeer.gwHost);

        // Uplink: Browser sends 160B ulaw -> Asterisk receives exact 160B ulaw RTP
        const agentUlawPayload = Buffer.alloc(160, 0x33);
        ulawWs.send(agentUlawPayload);

        await new Promise((r) => setTimeout(r, 80));
        assert.strictEqual(binaryMessages.length, 1, "Browser should receive 1 binary ulaw frame");
        assert.strictEqual(binaryMessages[0].length, 160, "Downlink ulaw frame must be 160 bytes");
        assert.ok(binaryMessages[0].equals(sampleUlawPayload), "Downlink ulaw payload must match RTP payload");
        assert.ok(ulawPeer.receivedPayloads.length >= 1, "Asterisk peer should receive uplink RTP packet");
        assert.strictEqual(ulawPeer.receivedPayloads[0].length, 160);
        assert.ok(ulawPeer.receivedPayloads[0].equals(agentUlawPayload), "Uplink RTP payload must match browser ulaw");

        ulawWs.close();
        await ariMediaService.closeMediaSession(ulawSession.id, "test_done");

        // 2. Test legacy default mode (NO codec param -> PCM 48 kHz 1920B frames, no handshake text)
        const legacySession = await ariMediaService.startMediaSessionByLinkedId("linked-pcm48-1", {
            owner: "agent",
            agentId: "101",
            transcribeRecording: false,
        });
        const legacyPeer = peers.get(legacySession.externalChannelId);
        const legacyWs = new WebSocket(`ws://127.0.0.1:${port}${legacySession.agentWebSocketPath}`);

        const legacyText = [];
        const legacyBin = [];
        await new Promise((resolve, reject) => {
            legacyWs.once("error", reject);
            legacyWs.on("message", (data, isBinary) => {
                if (!isBinary) legacyText.push(data.toString());
                else legacyBin.push(Buffer.from(data));
            });
            legacyWs.once("open", resolve);
        });

        await new Promise((r) => setTimeout(r, 40));
        assert.strictEqual(legacyText.length, 0, "Legacy client must NOT receive audio_config text frame");
        assert.strictEqual(ariMediaService.getMediaSession("linked-pcm48-1").agentCodec, "pcm48");

        const rtpPkt2 = buildRtpPacket(sampleUlawPayload, { sequence: 11, timestamp: 320, ssrc: 5678 });
        legacyPeer.sock.send(rtpPkt2, legacyPeer.gwPort, legacyPeer.gwHost);
        legacyWs.send(Buffer.alloc(1920, 0x00)); // 20ms PCM 48kHz

        await new Promise((r) => setTimeout(r, 80));
        assert.strictEqual(legacyBin.length, 1, "Legacy client should receive 1 PCM48 binary frame");
        assert.strictEqual(legacyBin[0].length, 1920, "Legacy downlink PCM48 frame must be 1920 bytes");
        assert.ok(legacyPeer.receivedPayloads.length >= 1, "Asterisk peer should receive legacy uplink RTP");
        assert.strictEqual(legacyPeer.receivedPayloads[0].length, 160);

        legacyWs.close();
        await ariMediaService.closeMediaSession(legacySession.id, "test_done");
    } finally {
        for (const peer of peers.values()) {
            try { peer.sock.close(); } catch (_) {}
        }
        server.close();
    }
}

async function testAriHangupReasonNormalization() {
    const receivedReasons = [];
    const mockAri = http.createServer((req, res) => {
        const parsed = new URL(req.url, "http://127.0.0.1");
        if (req.method === "DELETE" && parsed.pathname.startsWith("/ari/channels/")) {
            receivedReasons.push(parsed.searchParams.get("reason"));
            res.statusCode = 204;
            res.end();
            return;
        }
        res.statusCode = 404;
        res.end();
    });

    await new Promise((resolve) => mockAri.listen(0, "127.0.0.1", resolve));
    const port = mockAri.address().port;

    try {
        const client = createAriClient({
            logTag: "ari-test",
            getConfig: () => ({
                enabled: true,
                baseUrl: `http://127.0.0.1:${port}`,
                username: "ariana",
                password: "secret",
                appName: "ariana-trunk",
                requestTimeoutMs: 5000,
            }),
        });

        client.ingestEventForTest({
            type: "StasisStart",
            application: "ariana-trunk",
            args: [],
            channel: {
                id: "chan-reason-1",
                name: "Local/002@simulador-cola-0001;2",
                state: "Up",
                caller: { number: "0991000002", name: "Paciente 002" },
                dialplan: { context: "ariana-ari", exten: "s" },
            },
        });

        await client.hangupSession("chan-reason-1", "laravel_agent_97_hangup");
        await client.hangupSession("chan-reason-1", "busy");
        await client.hangupSession("chan-reason-1", "no-answer");
        await client.hangupSession("chan-reason-1", "congestion");

        assert.deepStrictEqual(receivedReasons, ["normal", "busy", "no_answer", "congestion"]);
    } finally {
        mockAri.close();
    }
}

async function main() {
    testLinearInterpolationAndFraming();
    await testWebSocketCodecNegotiation();
    await testAriHangupReasonNormalization();
    console.log("ARI ulaw WebSocket, interpolation & hangup reason tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

