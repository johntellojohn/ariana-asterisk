const app = require("./app");
const env = require("./config/env");
const ariService = require("./modules/ari/ari.service");
const { attachAriWebSocketServer } = require("./modules/ari/ari.websocket");
const pbxService = require("./modules/pbx/pbx.service");

const server = app.listen(env.port, () => {
    console.log(`${env.appName} running on port ${env.port}`);
});

pbxService.start();
ariService.start();
attachAriWebSocketServer(server);

process.on("SIGTERM", shutdown("SIGTERM"));
process.on("SIGINT", shutdown("SIGINT"));

function shutdown(signal) {
    return () => {
        console.log(`${signal} received. Closing server...`);
        pbxService.stop();
        ariService.stop();
        server.close(() => {
            console.log("Server closed.");
            process.exit(0);
        });
    };
}
