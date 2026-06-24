const express = require("express");

const ariController = require("./ari.controller");
const requireApiToken = require("../../middlewares/api-token.middleware");

const router = express.Router();

router.use(requireApiToken);

router.get("/health", ariController.health);
router.get("/events", ariController.events);
router.get("/sessions", ariController.sessions);
router.get("/media-sessions", ariController.mediaSessions);
router.get("/calls/:linkedid", ariController.showCall);
router.post("/calls/:linkedid/media-session", ariController.startCallMediaSession);
router.post("/calls/:linkedid/media-session/close", ariController.closeCallMediaSession);
router.post("/calls/:linkedid/answer", ariController.answerCall);
router.post("/calls/:linkedid/bridge", ariController.bridgeCall);
router.post("/calls/:linkedid/play", ariController.playCallMedia);
router.post("/calls/:linkedid/hangup", ariController.hangupCall);
router.get("/sessions/:channelId", ariController.showSession);
router.post("/sessions/:channelId/answer", ariController.answerSession);
router.post("/sessions/:channelId/bridge", ariController.bridgeSession);
router.post("/sessions/:channelId/play", ariController.playMedia);
router.post("/sessions/:channelId/hangup", ariController.hangupSession);

module.exports = router;
