const env = require("../config/env");
const ariService = require("../modules/ari/ari.service");
const ariBridgeService = require("../modules/ari/ari-bridge.service");
const pbxService = require("../modules/pbx/pbx.service");
const { resolveGatewayCapabilities } = require("../modules/pbx/asterisk-capabilities");
const renderHealthPage = require("../views/health-page");

function buildCapabilities() {
    return resolveGatewayCapabilities({
        ariStatus: ariService.getStatus(),
        pbxStatus: pbxService.getStatus(),
        configuredAnswerMode: env.pbxAnswerMode,
        sipBridgeStatus: ariBridgeService.getStatus(),
    });
}

function index(req, res) {
    const payload = {
        ok: true,
        service: env.appName,
        environment: env.nodeEnv,
        capabilities: buildCapabilities(),
        ari: ariService.getStatus(),
        sipBridge: ariBridgeService.getStatus(),
        pbx: pbxService.getStatus(),
    };

    respond(req, res, payload);
}

function health(req, res) {
    const payload = {
        ok: true,
        status: "healthy",
        timestamp: new Date().toISOString(),
        service: env.appName,
        environment: env.nodeEnv,
        capabilities: buildCapabilities(),
        ari: ariService.getStatus(),
        sipBridge: ariBridgeService.getStatus(),
        pbx: pbxService.getStatus(),
    };

    respond(req, res, payload);
}

module.exports = {
    index,
    health,
};

function respond(req, res, payload) {
    if (!wantsHtml(req)) {
        return res.json(payload);
    }

    return res.type("html").send(renderHealthPage({
        ok: payload.ok,
        title: "Ariana Asterisk",
        subtitle: "Gateway de llamadas troncales, Asterisk AMI y EVA.",
        service: payload.service || env.appName,
        environment: payload.environment || env.nodeEnv,
        timestamp: payload.timestamp || new Date().toISOString(),
        endpoint: req.originalUrl,
        ari: payload.ari,
        pbx: payload.pbx,
    }));
}

function wantsHtml(req) {
    return String(req.get("accept") || "").includes("text/html");
}
