const fs = require("fs/promises");
const path = require("path");
const env = require("../../config/env");
const configStore = require("../config/config-store.service");
const adminAuth = require("./admin-auth.service");
const auditLog = require("../audit/audit-log.service");
const heartbeatService = require("../audit/heartbeat.service");
const webhookDispatcher = require("../laravel/webhook-dispatcher.service");
const laravelService = require("../laravel/laravel.service");
const pbxService = require("../pbx/pbx.service");
const callState = require("../pbx/call-state.service");
const ariService = require("../ari/ari.service");
const ariMediaService = require("../ari/ari-media.service");

const ASSETS_DIR = path.join(__dirname, "assets");

function renderLoginHtml() {
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ariana Edge Gateway — Acceso Admin</title>
  <link rel="stylesheet" href="/admin/assets/admin.css" />
</head>
<body class="auth-body">
  <main class="auth-card">
    <div class="auth-brand">
      <span class="brand-badge">v2</span>
      <div>
        <h1>Ariana Edge Gateway</h1>
        <p>Consola Operativa LAN · Issabel ↔ EVA Cloud</p>
      </div>
    </div>
    <form id="login-form" class="stack-md">
      <label class="field">
        <span>Usuario</span>
        <input id="username" name="username" type="text" autocomplete="username" value="admin" required />
      </label>
      <label class="field">
        <span>Contraseña</span>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
      </label>
      <div id="login-error" class="alert alert-error hidden"></div>
      <button id="login-submit" class="btn btn-primary" type="submit">Ingresar al Panel</button>
    </form>
    <p class="auth-footnote">Autenticación autónoma en volumen persistente <code>./data</code></p>
  </main>
  <script src="/admin/assets/login.js" defer></script>
</body>
</html>`;
}

function renderAdminHtml() {
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ariana Edge Gateway v2 — Consola /admin</title>
  <link rel="stylesheet" href="/admin/assets/admin.css" />
</head>
<body class="app-body">
  <aside class="sidebar">
    <div class="sidebar-brand">
      <span class="brand-badge">v2</span>
      <div>
        <strong>Ariana Gateway</strong>
        <small id="sidebar-app-name">Edge Appliance</small>
      </div>
    </div>
    <nav class="nav-list" id="nav-tabs">
      <button class="nav-item active" data-tab="dashboard" type="button">Dashboard en Vivo</button>
      <button class="nav-item" data-tab="audit" type="button">Ingresos &amp; Caja Negra</button>
      <button class="nav-item" data-tab="config" type="button">Configuración PBX / EVA</button>
      <button class="nav-item" data-tab="diagnostics" type="button">Diagnóstico 1-Clic</button>
    </nav>
    <div class="sidebar-footer">
      <div id="setup-badge" class="pill pill-warn">Cargando...</div>
      <div class="sidebar-actions">
        <span id="current-user-label" class="muted">admin</span>
        <button id="logout-btn" class="btn btn-ghost btn-sm" type="button">Salir</button>
      </div>
    </div>
  </aside>

  <main class="main-shell">
    <header class="topbar">
      <div>
        <h1 id="page-title">Dashboard en Vivo</h1>
        <p id="page-subtitle" class="muted">Estado de enlaces LAN/WAN, cola FIFO offline y llamadas activas</p>
      </div>
      <div class="topbar-controls">
        <label class="toggle-inline">
          <input id="auto-refresh-toggle" type="checkbox" checked />
          <span>Auto-refresco 4s</span>
        </label>
        <button id="refresh-now-btn" class="btn btn-secondary btn-sm" type="button">Actualizar</button>
      </div>
    </header>

    <div id="must-change-banner" class="alert alert-warn hidden">
      Estás usando la contraseña temporal inicial. Actualízala en la pestaña <strong>Configuración PBX / EVA</strong>.
    </div>

    <section id="tab-dashboard" class="tab-panel active">
      <div class="kpi-grid" id="kpi-grid"></div>
      <div class="panel-card">
        <div class="panel-head">
          <h2>Llamadas Activas y Recientes (Tiempos: Espera vs Conversación)</h2>
          <div class="panel-actions">
            <button id="flush-outbox-btn" class="btn btn-secondary btn-sm" type="button">Drenar Outbox Offline</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>LinkedID</th>
                <th>Origen</th>
                <th>Cola / Ext</th>
                <th>Estado</th>
                <th>Espera</th>
                <th>Hablado</th>
                <th>Último Evento</th>
              </tr>
            </thead>
            <tbody id="calls-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section id="tab-audit" class="tab-panel">
      <div class="panel-card">
        <div class="panel-head">
          <h2>Caja Negra (Auditoría JSONL Diaria)</h2>
        </div>
        <form id="audit-filter-form" class="filter-bar">
          <select id="audit-day"></select>
          <select id="audit-category">
            <option value="">Todas las categorías</option>
            <option value="call">Llamadas</option>
            <option value="webhook">Webhooks EVA</option>
            <option value="queue">Presencia Cola</option>
            <option value="config">Configuración</option>
            <option value="system">Sistema</option>
          </select>
          <input id="audit-search" type="text" placeholder="Buscar linkedid, teléfono, cola..." />
          <button class="btn btn-primary btn-sm" type="submit">Filtrar</button>
        </form>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Hora</th>
                <th>Categoría</th>
                <th>Tipo</th>
                <th>LinkedID</th>
                <th>Origen</th>
                <th>Cola/Ext</th>
                <th>Resultado</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody id="audit-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section id="tab-config" class="tab-panel">
      <div class="panel-card">
        <div class="panel-head">
          <h2>Parámetros Runtime Persistentes (Cifrado AES-256-GCM en ./data)</h2>
        </div>
        <form id="config-form" class="stack-lg">
          <div id="config-sections" class="config-grid"></div>
          <div id="config-feedback" class="alert hidden"></div>
          <div class="form-actions">
            <button id="save-config-btn" class="btn btn-primary" type="submit">Guardar y Reconectar en Caliente</button>
          </div>
        </form>
      </div>

      <div class="panel-card">
        <div class="panel-head">
          <h2>Credenciales Administrativas /admin</h2>
        </div>
        <form id="credentials-form" class="inline-grid">
          <label class="field">
            <span>Contraseña Actual</span>
            <input id="cred-current" type="password" required />
          </label>
          <label class="field">
            <span>Nuevo Usuario</span>
            <input id="cred-username" type="text" required />
          </label>
          <label class="field">
            <span>Nueva Contraseña (mín. 8 caracteres)</span>
            <input id="cred-password" type="password" minlength="8" />
          </label>
          <div class="field align-end">
            <button class="btn btn-secondary" type="submit">Actualizar Acceso</button>
          </div>
        </form>
        <div id="cred-feedback" class="alert hidden"></div>
      </div>
    </section>

    <section id="tab-diagnostics" class="tab-panel">
      <div class="panel-card">
        <div class="panel-head">
          <h2>Diagnóstico Integral 1-Clic (LAN Issabel + WAN EVA + ./data)</h2>
          <div class="panel-actions">
            <input id="diag-queue-input" class="input-sm" type="text" value="650" placeholder="Cola (ej. 650)" />
            <button id="run-diag-btn" class="btn btn-primary btn-sm" type="button">Ejecutar Diagnóstico</button>
          </div>
        </div>
        <div id="diagnostics-results" class="diag-grid">
          <p class="muted">Presiona "Ejecutar Diagnóstico" para validar AMI, miembros de cola, ARI, EVA Cloud y almacenamiento ./data.</p>
        </div>
      </div>
    </section>
  </main>

  <script src="/admin/assets/admin.js" defer></script>
</body>
</html>`;
}

function loginPage(_req, res) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(renderLoginHtml());
}

function adminPage(req, res) {
    if (!adminAuth.extractSessionFromRequest(req)) {
        return res.redirect("/admin/login");
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(renderAdminHtml());
}

async function serveAsset(req, res) {
    const filename = path.basename(String(req.params.file || ""));
    const allowed = new Map([
        ["admin.css", "text/css; charset=utf-8"],
        ["login.js", "application/javascript; charset=utf-8"],
        ["admin.js", "application/javascript; charset=utf-8"],
    ]);

    const contentType = allowed.get(filename);
    if (!contentType) {
        return res.status(404).send("Not found");
    }

    const filePath = path.join(ASSETS_DIR, filename);
    const content = await fs.readFile(filePath, "utf8");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    return res.send(content);
}

async function loginApi(req, res) {
    const { username, password } = req.body || {};
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const result = await adminAuth.login(username, password, ip);

    if (!result.ok) {
        return res.status(result.status).json({
            ok: false,
            message: result.error,
            retryAfterSeconds: result.retryAfterSeconds || null,
        });
    }

    adminAuth.setSessionCookie(res, result.token, req);
    return res.json({
        ok: true,
        user: result.user,
    });
}

function logoutApi(_req, res) {
    adminAuth.clearSessionCookie(res);
    return res.json({ ok: true });
}

async function updateCredentialsApi(req, res) {
    const { currentPassword, newUsername, newPassword } = req.body || {};
    const result = await adminAuth.changeCredentials({
        currentPassword,
        newUsername,
        newPassword,
    });

    if (!result.ok) {
        return res.status(result.status).json({ ok: false, message: result.error });
    }

    adminAuth.setSessionCookie(res, result.token, req);
    auditLog.record({
        category: "config",
        type: "admin_credentials_updated",
        outcome: "ok",
        summary: `Updated admin credentials for ${result.user.username}`,
    });

    return res.json({
        ok: true,
        user: result.user,
    });
}

function computeSecondsBetween(startIso, endIso) {
    if (!startIso) return 0;
    const startMs = Date.parse(startIso);
    const endMs = endIso ? Date.parse(endIso) : Date.now();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
        return 0;
    }
    return Math.round((endMs - startMs) / 1000);
}

function getOverviewApi(_req, res) {
    const legacyCalls = pbxService.getCallsSummary().slice(0, 40);
    const mergedCalls = legacyCalls.map((call) => {
        const state = callState.getCall(call.linkedid);
        const waitEnd = state?.answeredAt || state?.endedAt || null;
        const waitStart = state?.queueJoinedAt || state?.firstEventAt || call.firstEventTime;
        const waitSeconds = computeSecondsBetween(waitStart, waitEnd);
        const talkSeconds = state?.answeredAt ? computeSecondsBetween(state.answeredAt, state.endedAt) : 0;

        return {
            linkedid: call.linkedid,
            from: state?.callerNumber || call.from || "-",
            queue: state?.queue || "-",
            extension: state?.answeredExtension || state?.targetExtension || call.to || "-",
            status: state?.status || call.status,
            answered: Boolean(state?.answered || call.answered),
            waitSeconds,
            talkSeconds,
            lastEventTime: state?.lastEventAt || call.lastEventTime,
        };
    });

    return res.json({
        ok: true,
        gateway: {
            appName: env.appName,
            buildVersion: env.buildVersion,
            port: env.port,
            uptimeSeconds: Math.round(process.uptime()),
            publicBaseUrl: env.publicBaseUrl,
        },
        user: adminAuth.getPublicUser(),
        configStatus: configStore.getStatus(),
        ami: pbxService.getStatus(),
        ari: ariService.getStatus(),
        rtp: ariMediaService.getMediaStats(),
        outbox: webhookDispatcher.getStats(),
        heartbeat: heartbeatService.getStatus(),
        calls: mergedCalls,
    });
}

async function getAuditApi(req, res) {
    const day = req.query.day ? String(req.query.day).trim() : "";
    const filters = {
        limit: Number(req.query.limit) || 150,
        category: req.query.category || "",
        linkedid: req.query.linkedid || "",
        queue: req.query.queue || "",
        search: req.query.search || "",
    };

    const days = await auditLog.listDays();
    const entries = day && day !== "live"
        ? await auditLog.readDay(day, filters)
        : auditLog.getRecent(filters);

    return res.json({
        ok: true,
        days,
        entries,
        outbox: webhookDispatcher.getStats(),
    });
}

async function flushOutboxApi(_req, res) {
    await webhookDispatcher.flush();
    return res.json({
        ok: true,
        outbox: webhookDispatcher.getStats(),
    });
}

function getConfigApi(_req, res) {
    return res.json({
        ok: true,
        ...configStore.getPublicConfig(),
    });
}

async function updateConfigApi(req, res) {
    const result = await configStore.updateConfig(req.body || {});
    const reconnected = { ami: false, ari: false };

    if (result.amiChanged || (env.pbxAmiEnabled && !pbxService.getStatus().connected && configStore.isAmiReady())) {
        if (configStore.isAmiReady()) {
            pbxService.restart();
            reconnected.ami = true;
        } else {
            pbxService.stop();
        }
    }

    if (result.ariChanged || (env.ariEnabled && !ariService.getStatus().connected && configStore.isAriReady())) {
        if (configStore.isAriReady()) {
            ariService.restart();
            reconnected.ari = true;
        } else {
            ariService.stop();
        }
    }

    auditLog.record({
        category: "config",
        type: "config_updated",
        outcome: result.status.configured ? "configured" : "pending",
        summary: `Changed keys: ${result.changedKeys.join(", ") || "none"}`,
    });

    return res.json({
        ok: true,
        changedKeys: result.changedKeys,
        reconnected,
        ...result.config,
    });
}

async function runDiagnosticsApi(req, res) {
    const queue = String((req.body && req.body.queue) || "650").trim();
    const checks = [];

    // 1. Config readiness
    const cfgStatus = configStore.getStatus();
    checks.push({
        id: "config",
        title: "Configuración Persistente (./data)",
        status: cfgStatus.configured ? "ok" : "warn",
        detail: cfgStatus.configured
            ? `Origen: ${cfgStatus.source} | Directorio: ${cfgStatus.dataDir}`
            : `Faltan campos: ${cfgStatus.pendingReasons.join(", ")}`,
    });

    // 2. AMI status & QueueStatus
    const pbxStatus = pbxService.getStatus();
    if (!pbxStatus.connected) {
        checks.push({
            id: "ami",
            title: "Issabel AMI (Puerto 5038)",
            status: "fail",
            detail: pbxStatus.lastAmiError || "AMI desconectado",
        });
    } else {
        try {
            const qRes = await pbxService.getQueueStatus(queue);
            const events = Array.isArray(qRes && qRes.events) ? qRes.events : [];
            const members = events.filter((item) => String(item.Event || item.event || "").toLowerCase() === "queuemember");
            checks.push({
                id: "ami",
                title: `Issabel AMI + Cola ${queue}`,
                status: "ok",
                detail: `Conectado a ${pbxStatus.host}:${pbxStatus.port}. Miembros en cola ${queue}: ${members.length}`,
            });
        } catch (error) {
            checks.push({
                id: "ami",
                title: `Issabel AMI + Cola ${queue}`,
                status: "warn",
                detail: `AMI conectado pero QueueStatus(${queue}) falló: ${error.message}`,
            });
        }
    }

    // 3. ARI REST & WS
    const ariStatus = ariService.getStatus();
    if (!env.ariEnabled) {
        checks.push({
            id: "ari",
            title: "Issabel ARI (WebSocket / Stasis)",
            status: "warn",
            detail: "ARI deshabilitado en configuración.",
        });
    } else {
        try {
            const info = await ariService.ariRequest("GET", "/asterisk/info");
            checks.push({
                id: "ari",
                title: "Issabel ARI (REST + WebSocket)",
                status: ariStatus.connected ? "ok" : "warn",
                detail: `REST OK (Asterisk ${info?.system?.version || "?"}) | WebSocket: ${ariStatus.connected ? "conectado" : "desconectado"}`,
            });
        } catch (error) {
            checks.push({
                id: "ari",
                title: "Issabel ARI (REST + WebSocket)",
                status: "fail",
                detail: `Error ARI REST: ${error.message}`,
            });
        }
    }

    // 4. EVA Cloud ping
    const evaCheck = await laravelService.pingEva(5000);
    checks.push({
        id: "eva",
        title: "EVA Cloud (Webhook + Heartbeat WAN)",
        status: evaCheck.ok ? "ok" : "fail",
        detail: evaCheck.ok
            ? `EVA accesible (${evaCheck.latencyMs}ms, HTTP ${evaCheck.status})${evaCheck.note ? " — " + evaCheck.note : ""}`
            : evaCheck.error,
    });

    // 5. Outbox & RTP
    const outboxStats = webhookDispatcher.getStats();
    const rtpStats = ariMediaService.getMediaStats();
    let diskWritable = true;
    try {
        await fs.access(env.dataDir, fs.constants.W_OK);
    } catch (_err) {
        diskWritable = false;
    }
    checks.push({
        id: "storage",
        title: "Almacenamiento ./data, Outbox & RTP",
        status: diskWritable && outboxStats.pendingCount === 0 ? "ok" : diskWritable ? "warn" : "fail",
        detail: `./data escribible: ${diskWritable ? "Sí" : "No"} | Outbox pendiente: ${outboxStats.pendingCount} | Sesiones RTP activas: ${rtpStats.activeCount}`,
    });

    return res.json({
        ok: true,
        ranAt: new Date().toISOString(),
        checks,
    });
}

module.exports = {
    loginPage,
    adminPage,
    serveAsset,
    loginApi,
    logoutApi,
    updateCredentialsApi,
    getOverviewApi,
    getAuditApi,
    flushOutboxApi,
    getConfigApi,
    updateConfigApi,
    runDiagnosticsApi,
};

