const WebSocket = require("ws");

const ariMediaService = require("./ari-media.service");

function attachAriWebSocketServer(server) {
    const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

    server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url || "", "http://localhost");
        const match = url.pathname.match(/^\/api\/ari\/calls\/([^/]+)\/agent-ws$/);

        if (!match) {
            return;
        }

        if (typeof socket.setNoDelay === "function") {
            socket.setNoDelay(true);
        }

        const linkedid = decodeURIComponent(match[1]);

        wss.handleUpgrade(request, socket, head, (ws) => {
            if (ws._socket && typeof ws._socket.setNoDelay === "function") {
                ws._socket.setNoDelay(true);
            }

            ariMediaService.attachAgentWebSocket(linkedid, ws, {
                key: url.searchParams.get("key") || "",
                agentId: url.searchParams.get("agent_id") || null,
                codec: url.searchParams.get("codec") || "",
            });
        });
    });
}

module.exports = {
    attachAriWebSocketServer,
};
