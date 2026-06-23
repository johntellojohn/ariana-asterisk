const env = require("../config/env");
const pbxService = require("../modules/pbx/pbx.service");

function index(req, res) {
    res.json({
        ok: true,
        service: env.appName,
        environment: env.nodeEnv,
    });
}

function health(req, res) {
    res.json({
        ok: true,
        status: "healthy",
        timestamp: new Date().toISOString(),
        pbx: pbxService.getStatus(),
    });
}

module.exports = {
    index,
    health,
};
