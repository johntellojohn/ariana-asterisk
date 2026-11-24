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
const { resolveGatewayCapabilities } = require("../pbx/asterisk-capabilities");
const ariService = require("../ari/ari.service");
const ariBridgeService = require("../ari/ari-bridge.service");
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
    <div id="compat-warning-banner" class="alert alert-warn hidden"></div>

    <section id="tab-dashboard" class="tab-panel active">
      <div class="kpi-grid" id="kpi-grid"></div>
      <div class="panel-card">
        <div class="panel-head">
          <h2>Cola de Espera y Miembros Issabel</h2>
          <div class="panel-actions">
            <button id="refresh-queue-btn" class="btn btn-secondary btn-sm" type="button">Consultar Cola Ahora</button>
          </div>
        </div>
        <div id="queue-overview-strip" class="muted">Cargando estado de cola y extensiones...</div>
      </div>
      <div class="panel-card">
        <div class="panel-head">
          <h2>Llamadas Activas y Recientes (Tiempos: Espera vs Conversación)</h2>
          <div class="panel-actions">
            <button id="flush-outbox-btn" class="btn btn-secondary btn-sm" type="button">Drenar Outbox Offline</button>
          </div>
        </div>
        <div id="calls-action-feedback" class="alert hidden"></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>LinkedID</th>
                <th>Canal PBX</th>
                <th>Origen</th>
                <th>Cola / Ext</th>
                <th>Estado</th>
                <th>Espera</th>
                <th>Hablado</th>
                <th>Último Evento</th>
                <th>Acción</th>
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
          <input id="audit-search" type="text" placeholder="Buscar linkedid, canal, teléfono, cola..." />
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
                <th>Canal PBX</th>
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

async function getOverviewApi(req, res) {
    const pbxStatus = pbxService.getStatus();
    const ariStatus = ariService.getStatus();
    const sipBridgeStatus = ariBridgeService.getStatus();
    const capabilities = resolveGatewayCapabilities({
        ariStatus,
        pbxStatus,
        configuredAnswerMode: env.pbxAnswerMode,
        sipBridgeStatus,
    });

    const forceRefreshQueue = String(req.query?.refreshQueue || "") === "1";
    const cachedQueue = pbxService.getCachedQueueSnapshot();
    const snapshotAgeMs = cachedQueue?.collectedAt ? Date.now() - Date.parse(cachedQueue.collectedAt) : Infinity;

    if (pbxStatus.connected && (forceRefreshQueue || !cachedQueue || snapshotAgeMs > 12000)) {
        try {
            const targetQueue = String(req.query?.queue || "").trim();
            await pbxService.getQueueStatus(targetQueue, { timeoutMs: forceRefreshQueue ? 2000 : 700 });
        } catch (_err) {
            // Keep existing snapshot if live query fails
        }
    }

    const legacyCalls = pbxService.getCallsSummary().slice(0, 60);
    const combinedByLinkedId = new Map(legacyCalls.map((item) => [item.linkedid, item]));
    for (const state of callState.getAllCalls()) {
        if (state && state.linkedid && !combinedByLinkedId.has(state.linkedid)) {
            combinedByLinkedId.set(state.linkedid, {
                linkedid: state.linkedid,
                from: state.callerNumber || "-",
                to: state.answeredExtension || state.targetExtension || state.queue || "-",
                status: state.status,
                answered: Boolean(state.answered),
                firstEventTime: state.firstEventAt,
                lastEventTime: state.lastEventAt,
                primaryChannel: state.primaryChannel || null,
                channels: Array.from(state.channels || []),
            });
        }
    }

    const activeWaitingStates = callState
        .getAllCalls()
        .filter((item) => ["QUEUE_WAITING", "RINGING"].includes(String(item.status || "").toUpperCase()))
        .sort((a, b) => Date.parse(a.queueJoinedAt || a.firstEventAt || 0) - Date.parse(b.queueJoinedAt || b.firstEventAt || 0));

    const queuePositionByLinkedId = new Map();
    activeWaitingStates.forEach((item, index) => {
        queuePositionByLinkedId.set(item.linkedid, index + 1);
    });

    const ACTIVE_CALL_STATUSES = new Set(["NEW", "QUEUE_WAITING", "RINGING", "ANSWERED", "ANSWER", "BRIDGED"]);

    const mergedCalls = Array.from(combinedByLinkedId.values()).map((call) => {
        const state = callState.getCall(call.linkedid);
        const waitEnd = state?.answeredAt || state?.endedAt || null;
        const waitStart = state?.queueJoinedAt || state?.firstEventAt || call.firstEventTime;
        const waitSeconds = computeSecondsBetween(waitStart, waitEnd);
        const talkSeconds = state?.answeredAt ? computeSecondsBetween(state.answeredAt, state.endedAt) : 0;
        const status = state?.status || call.status;
        const allChannels = Array.from(
            new Set([
                ...(state?.channels ? Array.from(state.channels) : []),
                ...(Array.isArray(call.channels) ? call.channels : []),
            ].filter(Boolean))
        );
        const channel =
            state?.primaryChannel ||
            call.primaryChannel ||
            allChannels[0] ||
            null;
        const agentChannelList = state?.agentChannels ? Array.from(state.agentChannels).filter(Boolean) : [];
        const preferredAgentChannel =
            [...agentChannelList].reverse().find((ch) => !String(ch).endsWith(";2")) ||
            agentChannelList[agentChannelList.length - 1] ||
            null;
        const dstChannel = preferredAgentChannel;

        return {
            linkedid: call.linkedid,
            channel,
            dstChannel,
            channels: allChannels,
            from: state?.callerNumber || call.from || "-",
            queue: state?.queue || "-",
            extension: state?.answeredExtension || state?.targetExtension || call.to || "-",
            status,
            isActive: ACTIVE_CALL_STATUSES.has(String(status || "").toUpperCase()),
            answered: Boolean(state?.answered || call.answered),
            queuePosition: queuePositionByLinkedId.get(call.linkedid) || null,
            waitSeconds,
            talkSeconds,
            firstEventTime: state?.firstEventAt || call.firstEventTime,
            lastEventTime: state?.lastEventAt || call.lastEventTime,
        };
    });

    const rankStatus = (status) => {
        const upper = String(status || "").toUpperCase();
        if (upper === "QUEUE_WAITING") return 1;
        if (upper === "RINGING") return 2;
        if (upper === "ANSWERED" || upper === "ANSWER") return 3;
        return 4;
    };

    mergedCalls.sort((a, b) => {
        const ra = rankStatus(a.status);
        const rb = rankStatus(b.status);
        if (ra !== rb) return ra - rb;
        if (ra < 4) {
            return Date.parse(a.firstEventTime || a.lastEventTime || 0) - Date.parse(b.firstEventTime || b.lastEventTime || 0);
        }
        return Date.parse(b.lastEventTime || 0) - Date.parse(a.lastEventTime || 0);
    });

    const waitingCalls = mergedCalls.filter((c) => String(c.status).toUpperCase() === "QUEUE_WAITING").length;
    const ringingCalls = mergedCalls.filter((c) => String(c.status).toUpperCase() === "RINGING").length;
    const answeredCalls = mergedCalls.filter((c) => ["ANSWERED", "ANSWER"].includes(String(c.status).toUpperCase())).length;
    const latestSnapshot = pbxService.getCachedQueueSnapshot();

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
        capabilities,
        ami: pbxStatus,
        ari: ariStatus,
        sipBridge: sipBridgeStatus,
        rtp: ariMediaService.getMediaStats(),
        outbox: webhookDispatcher.getStats(),
        heartbeat: heartbeatService.getStatus(),
        queueSummary: {
            waitingCalls,
            ringingCalls,
            answeredCalls,
            waitingList: activeWaitingStates.slice(0, 15).map((item, idx) => ({
                position: idx + 1,
                linkedid: item.linkedid,
                from: item.callerNumber || "-",
                queue: item.queue || "-",
                status: item.status,
                targetExtension: item.targetExtension || "-",
                waitSeconds: computeSecondsBetween(item.queueJoinedAt || item.firstEventAt, null),
            })),
            snapshot: latestSnapshot
                ? {
                      queue: latestSnapshot.queue,
                      collectedAt: latestSnapshot.collectedAt,
                      timedOut: Boolean(latestSnapshot.timedOut),
                      params: latestSnapshot.params || [],
                      members: latestSnapshot.members || [],
                      entries: latestSnapshot.entries || [],
                  }
                : null,
        },
        calls: mergedCalls.slice(0, 40),
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

async function hangupChannelApi(req, res) {
    const channel = String(req.body?.channel || "").trim();
    const linkedid = String(req.body?.linkedid || "").trim() || null;
    const reason = String(req.body?.reason || "admin_manual_hangup").trim() || "admin_manual_hangup";
    const actor = adminAuth.getPublicUser()?.username || "admin";

    if (!channel || channel.length > 160 || !/^[A-Za-z0-9_./@:;+-]+$/.test(channel)) {
        return res.status(400).json({
            ok: false,
            message: "Canal PBX inválido o vacío.",
        });
    }

    if (!pbxService.getStatus().connected) {
        return res.status(503).json({
            ok: false,
            message: "Issabel AMI no está conectado para colgar el canal.",
        });
    }

    try {
        const response = await pbxService.hangupChannelByName(channel, reason);
        auditLog.record({
            category: "system",
            type: "admin_channel_hangup",
            linkedid,
            channel,
            outcome: "ok",
            summary: `Canal colgado manualmente por ${actor} (${reason})`,
        });

        return res.json({
            ok: true,
            channel,
            linkedid,
            response,
        });
    } catch (error) {
        const message = error?.message || "No se pudo colgar el canal en Issabel.";
        const notFound = /no such channel|not found/i.test(message);

        auditLog.record({
            category: "system",
            type: "admin_channel_hangup",
            linkedid,
            channel,
            outcome: notFound ? "not_found" : "error",
            summary: `Fallo al colgar canal por ${actor}: ${message}`,
        });

        return res.status(notFound ? 409 : 502).json({
            ok: false,
            channel,
            message,
        });
    }
}

function getConfigApi(_req, res) {
    return res.json({
        ok: true,
        ...configStore.getPublicConfig(),
    });
}

async function updateConfigApi(req, res) {
    const result = await configStore.updateConfig(req.body || {});
    const reconnected = { ami: false, ari: false, sipBridge: false };

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

    if (result.bridgeChanged || (env.sipBridgeEnabled && !ariBridgeService.getStatus().connected && configStore.isSipBridgeReady())) {
        if (configStore.isSipBridgeReady()) {
            ariBridgeService.restart();
            reconnected.sipBridge = true;
        } else {
            ariBridgeService.stop();
        }
    }

    if (result.changedKeys.includes("pbxAnswerMode") || result.bridgeChanged) {
        heartbeatService.sendOnce().catch(() => {});
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
            if (!pbxStatus.asteriskVersion) {
                await pbxService.probeAmiAsteriskVersion().catch(() => {});
            }
            const refreshedPbx = pbxService.getStatus();
            const qRes = await pbxService.getQueueStatus(queue);
            const members = Array.isArray(qRes?.members)
                ? qRes.members
                : (Array.isArray(qRes?.events) ? qRes.events : []).filter(
                      (item) => String(item.Event || item.event || "").toLowerCase() === "queuemember"
                  );
            const entries = Array.isArray(qRes?.entries) ? qRes.entries : [];
            const activeCount = members.filter((m) => !m.paused).length;
            const pausedCount = members.filter((m) => m.paused).length;
            const memberPreview = members
                .slice(0, 8)
                .map((m) => `${m.extension || m.name || m.interface}=${m.statusLabel || m.status}${m.paused ? "[PAUSADO]" : ""}`)
                .join(", ");

            checks.push({
                id: "ami",
                title: `Issabel AMI + Cola ${queue}`,
                status: members.length > 0 ? "ok" : "warn",
                detail: `Conectado a ${pbxStatus.host}:${pbxStatus.port} (Asterisk ${refreshedPbx.asteriskVersion || "?"}). Miembros en cola ${queue}: ${members.length} (activos: ${activeCount}, pausados: ${pausedCount})${memberPreview ? ` [${memberPreview}]` : ""} | En espera: ${entries.length}`,
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

    // 3. ARI REST & WS + Version Compatibility
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
            await ariService.probeAsteriskInfo().catch(() => {});
            const info = await ariService.ariRequest("GET", "/asterisk/info");
            const latestAri = ariService.getStatus();
            const caps = resolveGatewayCapabilities({
                ariStatus: {
                    ...latestAri,
                    asteriskRawVersion: info?.data?.system?.version || latestAri.asteriskRawVersion,
                },
                pbxStatus: pbxService.getStatus(),
                configuredAnswerMode: env.pbxAnswerMode,
                sipBridgeStatus: ariBridgeService.getStatus(),
            });
            const extMediaTxt =
                caps.supportsExternalMedia === true
                    ? "externalMedia ARI: SÍ (>=16.6)"
                    : caps.supportsExternalMedia === false
                      ? "externalMedia ARI: NO (<16.6)"
                      : "externalMedia ARI: indeterminado";

            checks.push({
                id: "ari",
                title: "Issabel ARI + Compatibilidad Asterisk",
                status: ariStatus.connected && caps.compatibleWithConfiguredMode ? "ok" : "warn",
                detail: `REST OK (Asterisk ${info?.data?.system?.version || caps.asteriskVersion || "?"}) | WebSocket: ${ariStatus.connected ? "conectado" : "desconectado"} | ${extMediaTxt} | Modo: config=${caps.configuredAnswerMode}, efectivo=${caps.effectiveAnswerMode}`,
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

    // 6. SIP Media Bridge (Asterisk < 16.6 browser audio)
    const bridgeStatus = ariBridgeService.getStatus();
    if (!env.sipBridgeEnabled) {
        const legacyCaps = resolveGatewayCapabilities({
            ariStatus: ariService.getStatus(),
            pbxStatus: pbxService.getStatus(),
            configuredAnswerMode: env.pbxAnswerMode,
            sipBridgeStatus: bridgeStatus,
        });
        checks.push({
            id: "sip_bridge",
            title: "SIP Media Bridge (Audio Navegador < 16.6)",
            status: legacyCaps.supportsExternalMedia === true ? "ok" : "warn",
            detail:
                legacyCaps.supportsExternalMedia === true
                    ? "Deshabilitado (no requerido en Asterisk >= 16.6)."
                    : "Deshabilitado. Habilita sipBridgeEnabled y levanta asterisk-media-bridge para audio en navegador sobre Asterisk 13.x.",
        });
    } else {
        try {
            await ariBridgeService.probeAsteriskInfo().catch(() => {});
            const bridgeInfo = await ariBridgeService.ariRequest("GET", "/asterisk/info");
            const latestBridge = ariBridgeService.getStatus();
            checks.push({
                id: "sip_bridge",
                title: "SIP Media Bridge (Audio Navegador < 16.6)",
                status: latestBridge.connected ? "ok" : "warn",
                detail: `REST OK (Asterisk ${bridgeInfo?.data?.system?.version || latestBridge.asteriskVersion || "?"}) | WebSocket: ${latestBridge.connected ? "conectado" : "desconectado"} | Contexto Issabel: ${env.sipBridgeDialContext} | RTP Host: ${env.sipBridgeRtpHost}`,
            });
        } catch (error) {
            checks.push({
                id: "sip_bridge",
                title: "SIP Media Bridge (Audio Navegador < 16.6)",
                status: "fail",
                detail: `Error SIP Bridge ARI (${env.sipBridgeAriBaseUrl}): ${error.message}`,
            });
        }
    }

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
    hangupChannelApi,
    getConfigApi,
    updateConfigApi,
    runDiagnosticsApi,
};

