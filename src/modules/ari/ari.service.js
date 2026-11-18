const env = require("../../config/env");
const laravelService = require("../laravel/laravel.service");
const { createAriClient } = require("./ari-client.factory");

const ariClient = createAriClient({
    logTag: "ari",
    getConfig: () => ({
        enabled: env.ariEnabled,
        baseUrl: env.ariBaseUrl,
        wsUrl: env.ariWsUrl,
        username: env.ariUsername,
        password: env.ariPassword,
        appName: env.ariAppName,
        buildVersion: env.buildVersion,
        reconnectMs: env.ariReconnectMs,
        requestTimeoutMs: env.ariRequestTimeoutMs,
        maxEvents: env.ariMaxEvents,
        laravelEventsEnabled: env.ariLaravelEventsEnabled,
        autoAnswer: env.ariAutoAnswer,
        autoBridge: env.ariAutoBridge,
        autoPlaybackMedia: env.ariAutoPlaybackMedia,
        bridgeWaitMs: env.ariBridgeWaitMs,
        stasisWaitMs: env.ariStasisWaitMs,
    }),
    notifyLaravelFn: (payload) => laravelService.sendTrunkCallEvent(payload),
});

module.exports = ariClient;
