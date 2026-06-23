const crypto = require("crypto");
const env = require("../config/env");

function extractBearerToken(req) {
    const authorization = req.get("authorization") || "";

    if (authorization.toLowerCase().startsWith("bearer ")) {
        return authorization.slice(7).trim();
    }

    return req.get("x-asterisk-api-token") || req.get("x-voice-api-token") || "";
}

function tokensMatch(received, expected) {
    const receivedBuffer = Buffer.from(received);
    const expectedBuffer = Buffer.from(expected);

    return (
        receivedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    );
}

function requireApiToken(req, res, next) {
    if (!env.asteriskApiToken) {
        return next();
    }

    const token = extractBearerToken(req);

    if (!token || !tokensMatch(token, env.asteriskApiToken)) {
        return res.status(401).json({
            ok: false,
            message: "Invalid or missing API token",
        });
    }

    return next();
}

module.exports = requireApiToken;
