const env = require("../config/env");

function errorMiddleware(err, req, res, next) {
    const status = err.status || err.statusCode || 500;
    const message =
        status === 500 && env.nodeEnv === "production"
            ? "Internal server error"
            : err.message || "Internal server error";

    if (status >= 500) {
        console.error(err);
    } else {
        console.warn("[http:error]", {
            status,
            method: req.method,
            path: req.originalUrl,
            message,
        });
    }

    res.status(status).json({
        ok: false,
        message,
    });
}

module.exports = errorMiddleware;
