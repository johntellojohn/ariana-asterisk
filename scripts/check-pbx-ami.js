const pbxService = require("../src/modules/pbx/pbx.service");
const env = require("../src/config/env");

const connectWaitMs = toNumber(process.env.PBX_CHECK_WAIT_MS, 10000);
const eventWaitMs = toNumber(process.env.PBX_CHECK_EVENT_WAIT_MS, 30000);
const pollMs = 500;

async function main() {
    if (!env.pbxAmiEnabled) {
        console.error("PBX_AMI_ENABLED=false. Enable it before running the AMI check.");
        process.exitCode = 2;
        return;
    }

    console.log("Checking PBX AMI connection", {
        host: env.pbxAmiHost,
        port: env.pbxAmiPort,
        username: env.pbxAmiUsername,
        connectWaitMs,
        eventWaitMs,
    });

    pbxService.start();

    const connected = await waitFor(() => pbxService.getStatus().connected, connectWaitMs);
    const status = pbxService.getStatus();

    if (!connected) {
        console.error("PBX AMI did not connect in time.", status);
        pbxService.stop();
        process.exitCode = 1;
        return;
    }

    console.log("PBX AMI connected.", status);

    if (eventWaitMs <= 0) {
        pbxService.stop();
        return;
    }

    console.log(`Waiting ${eventWaitMs} ms for dial events. Make or receive a test call now.`);

    const hadEvents = await waitFor(() => pbxService.getCallEvents().length > 0, eventWaitMs);
    const events = pbxService.getCallEvents();

    if (!hadEvents) {
        console.warn("No tracked PBX events were received during the wait window.");
    } else {
        console.log("Tracked PBX events received:", JSON.stringify(events, null, 2));
        console.log("PBX calls summary:", JSON.stringify(pbxService.getCallsSummary(), null, 2));
    }

    pbxService.stop();
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
    console.error(error);
    pbxService.stop();
    process.exitCode = 1;
});
