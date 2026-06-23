const express = require("express");

const healthController = require("../controllers/health.controller");
const pbxRoutes = require("../modules/pbx/pbx.routes");

const router = express.Router();

router.get("/", healthController.index);
router.get("/health", healthController.health);

router.use("/pbx", pbxRoutes);

module.exports = router;
