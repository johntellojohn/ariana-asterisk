const axios = require("axios");
const env = require("../../config/env");

async function sendTrunkCallEvent(payload) {
    const path = env.laravelTrunkEventsPath.startsWith("/")
        ? env.laravelTrunkEventsPath
        : `/${env.laravelTrunkEventsPath}`;
    const url = `${env.laravelApiUrl.replace(/\/$/, "")}${path}`;

    const response = await axios.post(url, payload, {
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: env.laravelApiToken
                ? `Bearer ${env.laravelApiToken}`
                : undefined,
        },
        timeout: env.laravelCallbackTimeoutMs,
    });

    return response.data;
}

module.exports = {
    sendTrunkCallEvent,
};
