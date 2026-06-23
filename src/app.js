const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");

const env = require("./config/env");
const routes = require("./routes/index.routes");
const errorMiddleware = require("./middlewares/error.middleware");

const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors(buildCorsOptions()));
app.use(compression());

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(morgan("dev", {
    skip: (req) => req.path === "/api/health",
}));

app.use("/api", routes);

app.use((req, res) => {
    res.status(404).json({
        ok: false,
        message: "Route not found",
    });
});

app.use(errorMiddleware);

function buildCorsOptions() {
    if (env.corsOrigins.includes("*")) {
        return {};
    }

    return {
        origin(origin, callback) {
            if (!origin || env.corsOrigins.includes(origin)) {
                return callback(null, true);
            }

            return callback(new Error("Origin not allowed by CORS"));
        },
    };
}

module.exports = app;
