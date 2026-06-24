const WebSocket = require("ws");

const ariMediaService = require("./ari-media.service");

function attachAriWebSocketServer(server) {
    const wss = new WebSocket.Server({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url || "", "http://localhost");
        const match = url.pathname.match(/^\/api\/ari\/calls\/([^/]+)\/agent-ws$/);

        if (!match) {
            return;
        }

        const linkedid = decodeURIComponent(match[1]);

        wss.handleUpgrade(request, socket, head, (ws) => {
            ariMediaService.attachAgentWebSocket(linkedid, ws, {
                key: url.searchParams.get("key") || "",
                agentId: url.searchParams.get("agent_id") || null,
            });
        });
    });
}

module.exports = {
    attachAriWebSocketServer,
};
