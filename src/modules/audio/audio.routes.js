const express = require("express");
const audioController = require("./audio.controller");

const router = express.Router();

router.get("/:filename", audioController.streamAudio);
router.head("/:filename", audioController.streamAudio);

module.exports = router;
