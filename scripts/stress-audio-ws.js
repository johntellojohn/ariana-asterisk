const http = require("http");
const dgram = require("dgram");
const assert = require("assert");
const { monitorEventLoopDelay } = require("perf_hooks");
const WebSocket = require("ws");

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.CALL_RECORDING_ENABLED = "false";
process.env.CALL_RECORDING_TRANSCRIBE = "false";
process.env.ARI_EXTERNAL_MEDIA_HOST = "127.0.0.1";
process.env.ARI_EXTERNAL_MEDIA_BIND_HOST = "127.0.0.1";
process.env.ARI_EXTERNAL_MEDIA_PORT_START = process.env.ARI_EXTERNAL_MEDIA_PORT_START || "46000";
process.env.ARI_EXTERNAL_MEDIA_PORT_END = process.env.ARI_EXTERNAL_MEDIA_PORT_END || "46200";
process.env.TRUNK_HUMAN_DISCONNECT_TONE_ENABLED = "false";

const ariService = require("../src/modules/ari/ari.service");
const ariMediaService = require("../src/modules/ari/ari-media.service");
const { attachAriWebSocketServer } = require("../src/modules/ari/ari.websocket");
const { buildRtpPacket } = require("../src/modules/ari/rtp-media");

const SESSIONS = Math.max(1, Number(process.env.STRESS_SESSIONS || 30));
const DURATION_MS = Math.max(2000, Number(process.env.STRESS_DURATION_MS || 10000));

function bindPeerUdp() {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket("udp4");
        sock.once("error", reject);
        sock.bind(0, "127.0.0.1", () => {
            sock.removeListener("error", reject);
            resolve(sock);
        });
    });
}

async function main() {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();

    const peers = new Map();
    let seqCounter = 0;

    ariService.getSessionByLinkedId = (linkedid) => ({
        linkedid,
        channelId: `SIP/sim-${linkedid}`,
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
        channelId: `SIP/sim-${linkedid}`,
        bridgeId: `bridge-${linkedid}`,
    });
    ariService.ariRequest = async (method, urlPath, config = {}) => {
        if (method === "post" && urlPath === "/channels/externalMedia") {
            const peerSock = await bindPeerUdp();
            const extId = `UnicastRTP/stress-${++seqCounter}`;
            const [gwHost, gwPort] = String(config?.params?.external_host || "127.0.0.1:0").split(":");
            const peer = {
                extId,
                sock: peerSock,
                port: peerSock.address().port,
                gwHost,
                gwPort: Number(gwPort),
                rxPackets: 0,
            };
            peerSock.on("message", () => {
                peer.rxPackets += 1;
            });
            peers.set(extId, peer);
            return { data: { id: extId } };
        }
        if (method === "get" && urlPath.includes("/variable")) {
            const extId = decodeURIComponent(urlPath.split("/")[2]);
            const peer = peers.get(extId);
            const variable = config?.params?.variable;
            if (!peer) {
                throw new Error("Peer not found");
            }
            return {
                data: {
                    value: variable === "UNICASTRTP_LOCAL_ADDRESS" ? "127.0.0.1" : String(peer.port),
                },
            };
        }
        return { data: { ok: true } };
    };

    const server = http.createServer((req, res) => {
        res.statusCode = 200;
        res.end("ok");
    });
    attachAriWebSocketServer(server);

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const baseHeapMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    const ulawSilence = Buffer.alloc(160, 0xff);
    const pcm48Frame = Buffer.alloc(1920, 0x01); // 20ms @ 48kHz mono PCM16LE
    const clients = [];

    for (let i = 0; i < SESSIONS; i += 1) {
        const linkedid = `stress-call-${i + 1}`;
        const session = await ariMediaService.startMediaSessionByLinkedId(linkedid, {
            owner: "agent",
            agentId: String(1000 + i),
            transcribeRecording: false,
        });

        const ws = new WebSocket(`ws://127.0.0.1:${port}${session.agentWebSocketPath}`);
        const rtpState = {
            sequence: 1,
            timestamp: 160,
            ssrc: 0x100000 + i,
        };
        const clientState = {
            linkedid,
            sessionId: session.id,
            ws,
            wsFramesIn: 0,
            rtpState,
            timer: null,
        };

        ws.on("message", () => {
            clientState.wsFramesIn += 1;
        });

        await new Promise((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
        });

        const peer = Array.from(peers.values())[i];
        clientState.timer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(pcm48Frame, { binary: true });
            }
            const rtpPacket = buildRtpPacket(ulawSilence, clientState.rtpState);
            peer.sock.send(rtpPacket, session.rtpPort, "127.0.0.1");
        }, 20);

        clients.push(clientState);
    }

    await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

    const midStats = ariMediaService.getMediaStats();
    const midHeapMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const totalWsFramesIn = clients.reduce((acc, c) => acc + c.wsFramesIn, 0);
    const totalPeerRtpRx = Array.from(peers.values()).reduce((acc, p) => acc + p.rxPackets, 0);

    for (const c of clients) {
        clearInterval(c.timer);
        if (c.ws.readyState === WebSocket.OPEN) {
            c.ws.close(1000, "stress_done");
        }
        await ariMediaService.closeMediaSession(c.sessionId, "stress_done");
    }

    for (const peer of peers.values()) {
        try {
            peer.sock.close();
        } catch (_) {}
    }

    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 150));
    histogram.disable();

    const endStats = ariMediaService.getMediaStats();
    const p99LagMs = Number((histogram.percentile(99) / 1e6).toFixed(2));
    const maxLagMs = Number((histogram.max / 1e6).toFixed(2));

    console.log(JSON.stringify({
        sessions: SESSIONS,
        durationMs: DURATION_MS,
        baseHeapMb,
        midHeapMb,
        p99EventLoopLagMs: p99LagMs,
        maxEventLoopLagMs: maxLagMs,
        midStats,
        totalWsFramesIn,
        totalPeerRtpRx,
        endStats,
    }, null, 2));

    assert.strictEqual(midStats.activeCount, SESSIONS, "All concurrent sessions must remain active during stress window");
    assert(midStats.totalPacketsIn >= SESSIONS * 20, "Inbound RTP packets from Asterisk should stream");
    assert(totalWsFramesIn >= SESSIONS * 20, "Browser WebSockets should receive decoded PCM audio");
    assert(totalPeerRtpRx >= SESSIONS * 20, "Asterisk UDP peers should receive encoded RTP audio from browser WS");
    assert.strictEqual(endStats.activeCount, 0, "Zero sessions should remain active after cleanup");
    assert.strictEqual(endStats.totalCachedCount, 0, "Zero sessions should remain cached after cleanup");
}

main().catch((err) => {
    console.error("[stress-audio-ws] FAILED:", err);
    process.exit(1);
});
