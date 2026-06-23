const axios = require("axios");
const env = require("../../config/env");

async function sendTrunkCallEvent(payload) {
    const path = env.laravelTrunkEventsPath.startsWith("/")
        ? env.laravelTrunkEventsPath
        : `/${env.laravelTrunkEventsPath}`;
    const url = `${env.laravelApiUrl.replace(/\/$/, "")}${path}`;
    const body = withTenantMetadata(payload);

    const response = await axios.post(url, body, {
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

function withTenantMetadata(payload) {
    if (!env.laravelTenantDatabase) {
        return payload;
    }

    return {
        ...payload,
        tenant: payload.tenant || env.laravelTenantDatabase,
        database: payload.database || env.laravelTenantDatabase,
        metadata: {
            ...(payload.metadata || {}),
            tenant: payload.metadata?.tenant || env.laravelTenantDatabase,
            database: payload.metadata?.database || env.laravelTenantDatabase,
        },
    };
}

module.exports = {
    sendTrunkCallEvent,
};
