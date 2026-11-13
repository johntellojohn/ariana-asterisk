const express = require("express");
const adminAuth = require("./admin-auth.service");
const adminController = require("./admin.controller");

const router = express.Router();

// Public UI & static assets (CSP-compliant, zero inline JS)
router.get("/login", adminController.loginPage);
router.get("/assets/:file", adminController.serveAsset);
router.post("/api/login", adminController.loginApi);

// Protected UI shell & API endpoints
router.get("/", adminAuth.requireAdminAuth("page"), adminController.adminPage);
router.post("/api/logout", adminAuth.requireAdminAuth("api"), adminController.logoutApi);
router.post("/api/credentials", adminAuth.requireAdminAuth("api"), adminController.updateCredentialsApi);
router.get("/api/overview", adminAuth.requireAdminAuth("api"), adminController.getOverviewApi);
router.get("/api/audit", adminAuth.requireAdminAuth("api"), adminController.getAuditApi);
router.post("/api/outbox/flush", adminAuth.requireAdminAuth("api"), adminController.flushOutboxApi);
router.get("/api/config", adminAuth.requireAdminAuth("api"), adminController.getConfigApi);
router.post("/api/config", adminAuth.requireAdminAuth("api"), adminController.updateConfigApi);
router.post("/api/diagnostics", adminAuth.requireAdminAuth("api"), adminController.runDiagnosticsApi);

module.exports = router;

