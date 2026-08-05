function isLocalOrPrivateHost(hostname) {
    return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname.startsWith("10.") ||
        hostname.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
}

function normalizePublicBaseUrl(value, nodeEnv = process.env.NODE_ENV) {
    const baseUrl = String(value || "").trim().replace(/\/$/, "");

    if (!baseUrl || nodeEnv !== "production") {
        return baseUrl;
    }

    try {
        const parsed = new URL(baseUrl);

        if (parsed.protocol === "http:" && !isLocalOrPrivateHost(parsed.hostname)) {
            parsed.protocol = "https:";
            return parsed.toString().replace(/\/$/, "");
        }
    } catch (_error) {
        return baseUrl;
    }

    return baseUrl;
}

module.exports = {
    normalizePublicBaseUrl,
};
