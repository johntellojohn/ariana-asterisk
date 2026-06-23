require("dotenv").config();

const axios = require("axios");

const linkedid = process.argv[2] || "";
const baseUrl = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.HOST_PORT || process.env.PORT || 366}`).replace(/\/$/, "");
const token = process.env.ASTERISK_API_TOKEN || process.env.VOICE_API_TOKEN || "";

async function main() {
    if (!linkedid) {
        console.error("Usage: npm run diagnose:call -- <linkedid>");
        process.exit(1);
    }

    if (!token) {
        console.error("Missing ASTERISK_API_TOKEN or VOICE_API_TOKEN in .env");
        process.exit(1);
    }

    const response = await axios.get(`${baseUrl}/api/pbx/calls/${encodeURIComponent(linkedid)}/diagnostics`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
        },
        timeout: 15000,
    });

    const data = response.data?.data || response.data;
    console.log(JSON.stringify({
        linkedid: data.linkedid,
        diagnosis: data.diagnosis,
        facts: data.facts,
        actions: data.actions,
        recentRawEvents: data.recentRawEvents,
    }, null, 2));
}

main().catch((error) => {
    console.error("Call diagnosis failed", {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
    });
    process.exit(1);
});
