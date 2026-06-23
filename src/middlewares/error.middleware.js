const env = require("../config/env");

function errorMiddleware(err, req, res, next) {
    console.error(err);

    const status = err.status || err.statusCode || 500;
    const message =
        status === 500 && env.nodeEnv === "production"
            ? "Internal server error"
            : err.message || "Internal server error";

    res.status(status).json({
        ok: false,
        message,
    });
}

module.exports = errorMiddleware;
