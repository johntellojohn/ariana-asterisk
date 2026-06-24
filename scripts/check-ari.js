const axios = require("axios");

const ariService = require("../src/modules/ari/ari.service");
const env = require("../src/config/env");

const connectWaitMs = toNumber(process.env.ARI_CHECK_WAIT_MS, 10000);
const eventWaitMs = toNumber(process.env.ARI_CHECK_EVENT_WAIT_MS, 30000);
const pollMs = 500;

async function main() {
    if (!env.ariEnabled) {
        console.error("ARI_ENABLED=false. Enable it before running the ARI check.");
        process.exitCode = 2;
        return;
    }

    console.log("Checking ARI REST", {
        baseUrl: env.ariBaseUrl,
        appName: env.ariAppName,
        username: env.ariUsername,
    });

    const info = await getAsteriskInfo();
    console.log("ARI REST responded.", {
        system: info.system,
        asteriskId: info.asterisk_id,
    });

    console.log("Checking ARI WebSocket", {
        connectWaitMs,
        eventWaitMs,
    });

    ariService.start();

    const connected = await waitFor(() => ariService.getStatus().connected, connectWaitMs);
    const status = ariService.getStatus();

    if (!connected) {
        console.error("ARI WebSocket did not connect in time.", status);
        ariService.stop();
        process.exitCode = 1;
        return;
    }

    console.log("ARI WebSocket connected.", status);

    if (eventWaitMs <= 0) {
        ariService.stop();
        return;
    }

    console.log(`Waiting ${eventWaitMs} ms for ARI events. Send a test call to Stasis(${env.ariAppName}) now.`);

    const hadEvents = await waitFor(() => ariService.getEvents().length > 0, eventWaitMs);
    const events = ariService.getEvents();

    if (!hadEvents) {
        console.warn("No ARI events were received during the wait window.");
    } else {
        console.log("ARI events received:", JSON.stringify(events, null, 2));
        console.log("ARI sessions:", JSON.stringify(ariService.listSessions(), null, 2));
    }

    ariService.stop();
}

async function getAsteriskInfo() {
    const response = await axios.get(`${env.ariBaseUrl.replace(/\/$/, "")}/ari/asterisk/info`, {
        auth: {
            username: env.ariUsername,
            password: env.ariPassword,
        },
        timeout: env.ariRequestTimeoutMs,
    });

    return response.data || {};
}

function waitFor(predicate, timeoutMs) {
    const startedAt = Date.now();

    return new Promise((resolve) => {
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve(true);
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, pollMs);
    });
}

function toNumber(value, fallback) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
}

main().catch((error) => {
    console.error("ARI check failed", {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
    });
    ariService.stop();
    process.exitCode = 1;
});
