const express = require("express");

const healthController = require("../controllers/health.controller");
const ariRoutes = require("../modules/ari/ari.routes");
const pbxRoutes = require("../modules/pbx/pbx.routes");

const router = express.Router();

router.get("/", healthController.index);
router.get("/health", healthController.health);

router.use("/ari", ariRoutes);
router.use("/pbx", pbxRoutes);

module.exports = router;
