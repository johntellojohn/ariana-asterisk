(function () {
  const TAB_META = {
    dashboard: {
      title: "Dashboard en Vivo",
      subtitle: "Estado de enlaces LAN/WAN, cola FIFO offline y llamadas activas",
    },
    audit: {
      title: "Ingresos & Caja Negra",
      subtitle: "Bitácora diaria JSONL e inspección de colas offline / dead-letters",
    },
    config: {
      title: "Configuración PBX / EVA",
      subtitle: "Persistencia cifrada AES-256-GCM en ./data y reconexión en caliente",
    },
    diagnostics: {
      title: "Diagnóstico 1-Clic",
      subtitle: "Validación inmediata AMI + Cola Issabel + ARI + EVA Cloud + RTP",
    },
  };

  const CONFIG_SCHEMA = [
    {
      title: "1. Gateway Local & Seguridad",
      fields: [
        { key: "appName", label: "Nombre del Gateway", type: "text" },
        { key: "publicBaseUrl", label: "URL Pública (HTTPS/DDNS)", type: "text" },
        { key: "asteriskApiToken", label: "Token API Inbound/EVA", type: "password" },
        { key: "corsOrigins", label: "Orígenes CORS (coma)", type: "list" },
      ],
    },
    {
      title: "2. EVA Cloud SaaS",
      fields: [
        { key: "laravelApiUrl", label: "EVA Base URL", type: "text" },
        { key: "laravelApiToken", label: "EVA Bearer Token", type: "password" },
        { key: "laravelTenantDatabase", label: "Base Tenant (sigcrm_...)", type: "text" },
        { key: "laravelTrunkEventsPath", label: "Ruta Webhooks", type: "text" },
        { key: "laravelTrunkEventsEnabled", label: "Enviar Webhooks a EVA", type: "checkbox" },
        { key: "laravelHeartbeatEnabled", label: "Enviar Heartbeat 60s", type: "checkbox" },
      ],
    },
    {
      title: "3. Issabel AMI & Cola",
      fields: [
        { key: "pbxAmiEnabled", label: "Habilitar AMI", type: "checkbox" },
        { key: "pbxAmiHost", label: "Host IP Issabel", type: "text" },
        { key: "pbxAmiPort", label: "Puerto AMI", type: "number" },
        { key: "pbxAmiUsername", label: "Usuario AMI", type: "text" },
        { key: "pbxAmiPassword", label: "Contraseña AMI", type: "password" },
        { key: "pbxOriginateContext", label: "Contexto Originate", type: "text" },
        { key: "pbxCallerIdPrefix", label: "Prefijo CallerID", type: "text" },
        { key: "trunkOutboundEnabled", label: "Habilitar Salientes Troncal", type: "checkbox" },
      ],
    },
    {
      title: "4. Issabel ARI & Audio RTP",
      fields: [
        { key: "ariEnabled", label: "Habilitar ARI", type: "checkbox" },
        { key: "ariBaseUrl", label: "ARI Base URL", type: "text" },
        { key: "ariUsername", label: "Usuario ARI", type: "text" },
        { key: "ariPassword", label: "Contraseña ARI", type: "password" },
        { key: "ariAppName", label: "Nombre App Stasis", type: "text" },
        { key: "ariExternalMediaHost", label: "IP Host ExternalMedia RTP", type: "text" },
        { key: "ariExternalMediaPortStart", label: "RTP Puerto Inicio", type: "number" },
        { key: "ariExternalMediaPortEnd", label: "RTP Puerto Fin", type: "number" },
      ],
    },
    {
      title: "5. Voz IA & Grabación",
      fields: [
        { key: "trunkAiEnabled", label: "Habilitar Agente IA", type: "checkbox" },
        { key: "openaiApiKey", label: "OpenAI API Key", type: "password" },
        { key: "callRecordingEnabled", label: "Grabación de Llamadas", type: "checkbox" },
        { key: "callRecordingTranscribe", label: "Transcribir Audio", type: "checkbox" },
      ],
    },
  ];

  let activeTab = "dashboard";
  let refreshTimer = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDuration(seconds) {
    const num = Math.max(0, Number(seconds) || 0);
    const mins = Math.floor(num / 60);
    const secs = num % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  function formatTime(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString();
  }

  async function apiJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (response.status === 401) {
      window.location.href = "/admin/login";
      throw new Error("Sesión expirada");
    }
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `HTTP ${response.status}`);
    }
    return data;
  }

  function switchTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabId);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `tab-${tabId}`);
    });
    const meta = TAB_META[tabId] || TAB_META.dashboard;
    document.getElementById("page-title").textContent = meta.title;
    document.getElementById("page-subtitle").textContent = meta.subtitle;

    if (tabId === "dashboard") loadOverview();
    if (tabId === "audit") loadAudit();
    if (tabId === "config") loadConfig();
  }

  function statusPill(status) {
    const upper = String(status || "").toUpperCase();
    let cls = "pill-info";
    if (["ANSWERED", "ANSWER", "ENDED", "OK"].includes(upper)) cls = "pill-ok";
    else if (["QUEUE_WAITING", "RINGING", "WARN"].includes(upper)) cls = "pill-warn";
    else if (["ABANDONED", "FAILED", "BUSY", "NOANSWER", "FAIL"].includes(upper)) cls = "pill-fail";
    return `<span class="pill ${cls}">${escapeHtml(upper || "-")}</span>`;
  }

  async function loadOverview() {
    try {
      const data = await apiJson("/admin/api/overview");
      document.getElementById("sidebar-app-name").textContent = data.gateway.appName || "Edge Appliance";
      document.getElementById("current-user-label").textContent = data.user?.username || "admin";
      document.getElementById("cred-username").value = data.user?.username || "admin";

      const mustChangeBanner = document.getElementById("must-change-banner");
      mustChangeBanner.classList.toggle("hidden", !data.user?.mustChangePassword);

      const setupBadge = document.getElementById("setup-badge");
      setupBadge.textContent = data.configStatus.configured ? "Configurado y Listo" : "Setup Pendiente";
      setupBadge.className = `pill ${data.configStatus.configured ? "pill-ok" : "pill-warn"}`;

      const kpis = [
        {
          label: "Issabel AMI",
          value: data.ami.connected ? "Conectado" : "Desconectado",
          sub: `${data.ami.host || "-"}:${data.ami.port || "-"}`,
          cls: data.ami.connected ? "pill-ok" : "pill-fail",
        },
        {
          label: "Issabel ARI WS",
          value: data.ari.connected ? "Activo" : "Inactivo",
          sub: `Sesiones: ${data.ari.activeSessions} activas / ${data.ari.totalSessions} cache`,
          cls: data.ari.connected ? "pill-ok" : "pill-warn",
        },
        {
          label: "EVA Cloud WAN",
          value: data.outbox.online ? "En Línea" : "Offline (Cola)",
          sub: `Pendientes FIFO: ${data.outbox.pendingCount} | Sync hist: ${data.outbox.historicalSyncedCount}`,
          cls: data.outbox.online ? "pill-ok" : "pill-warn",
        },
        {
          label: "Llamadas / RTP",
          value: `${data.ami.activeCallsCount ?? 0} activas`,
          sub: `RTP activos: ${data.rtp.activeCount} | Pkt in: ${data.rtp.totalPacketsIn}`,
          cls: "pill-info",
        },
        {
          label: "Heartbeat EVA",
          value: data.heartbeat.evaReachable === null ? "Pendiente" : data.heartbeat.evaReachable ? "OK" : "Sin red",
          sub: data.heartbeat.lastLatencyMs ? `Latencia: ${data.heartbeat.lastLatencyMs}ms` : "Cada 60s",
          cls: data.heartbeat.evaReachable ? "pill-ok" : "pill-warn",
        },
      ];

      document.getElementById("kpi-grid").innerHTML = kpis
        .map(
          (k) => `
          <div class="kpi-card">
            <div class="kpi-label">${escapeHtml(k.label)}</div>
            <div class="kpi-value"><span class="pill ${k.cls}">${escapeHtml(k.value)}</span></div>
            <div class="kpi-sub">${escapeHtml(k.sub)}</div>
          </div>`
        )
        .join("");

      const callsBody = document.getElementById("calls-tbody");
      if (!data.calls || data.calls.length === 0) {
        callsBody.innerHTML = `<tr><td colspan="7" class="muted">Sin llamadas registradas aún.</td></tr>`;
      } else {
        callsBody.innerHTML = data.calls
          .map(
            (call) => `
            <tr>
              <td><code>${escapeHtml(call.linkedid)}</code></td>
              <td>${escapeHtml(call.from)}</td>
              <td>${escapeHtml(call.queue)} / ${escapeHtml(call.extension)}</td>
              <td>${statusPill(call.status)}</td>
              <td>${formatDuration(call.waitSeconds)}</td>
              <td>${call.talkSeconds > 0 ? formatDuration(call.talkSeconds) : "-"}</td>
              <td>${escapeHtml(formatTime(call.lastEventTime))}</td>
            </tr>`
          )
          .join("");
      }
    } catch (error) {
      console.error("[admin] overview failed", error);
    }
  }

  async function loadAudit() {
    try {
      const daySelect = document.getElementById("audit-day");
      const day = daySelect.value || "live";
      const category = document.getElementById("audit-category").value;
      const search = document.getElementById("audit-search").value.trim();

      const params = new URLSearchParams({ day, category, search, limit: "150" });
      const data = await apiJson(`/admin/api/audit?${params.toString()}`);

      const currentDay = daySelect.value || "live";
      daySelect.innerHTML = `<option value="live">Tiempo Real (Memoria)</option>` +
        (data.days || []).map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
      daySelect.value = currentDay;

      const tbody = document.getElementById("audit-tbody");
      if (!data.entries || data.entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="muted">Sin eventos para los filtros seleccionados.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.entries
        .map(
          (item) => `
          <tr>
            <td>${escapeHtml(formatTime(item.ts))}</td>
            <td><span class="pill pill-info">${escapeHtml(item.category)}</span></td>
            <td>${escapeHtml(item.type)}</td>
            <td><code>${escapeHtml(item.linkedid || "-")}</code></td>
            <td>${escapeHtml(item.caller || "-")}</td>
            <td>${escapeHtml(item.queue || "-")} / ${escapeHtml(item.agentExtension || "-")}</td>
            <td>${escapeHtml(item.outcome || "-")}</td>
            <td>${escapeHtml(item.summary || "-")}</td>
          </tr>`
        )
        .join("");
    } catch (error) {
      console.error("[admin] audit load failed", error);
    }
  }

  async function loadConfig() {
    const container = document.getElementById("config-sections");
    try {
      const data = await apiJson("/admin/api/config");
      const values = data.values || {};
      const secretsSet = data.secretsSet || {};

      container.innerHTML = CONFIG_SCHEMA.map((group) => {
        const fieldsHtml = group.fields
          .map((field) => {
            const val = values[field.key];
            if (field.type === "checkbox") {
              return `
                <label class="checkbox-field">
                  <input type="checkbox" data-key="${field.key}" data-type="checkbox" ${val ? "checked" : ""} />
                  <span>${escapeHtml(field.label)}</span>
                </label>`;
            }
            const displayVal = field.type === "list"
              ? (Array.isArray(val) ? val.join(", ") : String(val || "*"))
              : String(val ?? "");
            const placeholder = field.type === "password" && secretsSet[field.key]
              ? "Secreto guardado (sin cambio si queda ****)"
              : "";
            return `
              <label class="field">
                <span>${escapeHtml(field.label)}</span>
                <input
                  data-key="${field.key}"
                  data-type="${field.type}"
                  type="${field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}"
                  value="${escapeHtml(displayVal)}"
                  placeholder="${escapeHtml(placeholder)}"
                />
              </label>`;
          })
          .join("");

        return `<div class="config-group"><h3>${escapeHtml(group.title)}</h3>${fieldsHtml}</div>`;
      }).join("");
    } catch (error) {
      container.innerHTML = `<p class="alert alert-error">${escapeHtml(error.message)}</p>`;
    }
  }

  async function saveConfig(event) {
    event.preventDefault();
    const feedback = document.getElementById("config-feedback");
    const saveBtn = document.getElementById("save-config-btn");
    feedback.classList.add("hidden");
    saveBtn.disabled = true;

    const payload = {};
    document.querySelectorAll("#config-sections [data-key]").forEach((input) => {
      const key = input.dataset.key;
      const type = input.dataset.type;
      if (type === "checkbox") {
        payload[key] = Boolean(input.checked);
      } else if (type === "number") {
        if (input.value !== "") payload[key] = Number(input.value);
      } else {
        payload[key] = input.value;
      }
    });

    try {
      const res = await apiJson("/admin/api/config", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      feedback.className = "alert alert-ok";
      feedback.textContent = `Guardado en ./data (AES-256-GCM). Reconectado AMI=${res.reconnected.ami}, ARI=${res.reconnected.ari}.`;
      feedback.classList.remove("hidden");
      loadOverview();
      loadConfig();
    } catch (error) {
      feedback.className = "alert alert-error";
      feedback.textContent = error.message;
      feedback.classList.remove("hidden");
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function saveCredentials(event) {
    event.preventDefault();
    const feedback = document.getElementById("cred-feedback");
    feedback.classList.add("hidden");

    const currentPassword = document.getElementById("cred-current").value;
    const newUsername = document.getElementById("cred-username").value.trim();
    const newPassword = document.getElementById("cred-password").value;

    try {
      await apiJson("/admin/api/credentials", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newUsername, newPassword }),
      });
      document.getElementById("cred-current").value = "";
      document.getElementById("cred-password").value = "";
      feedback.className = "alert alert-ok";
      feedback.textContent = "Credenciales actualizadas correctamente.";
      feedback.classList.remove("hidden");
      loadOverview();
    } catch (error) {
      feedback.className = "alert alert-error";
      feedback.textContent = error.message;
      feedback.classList.remove("hidden");
    }
  }

  async function runDiagnostics() {
    const grid = document.getElementById("diagnostics-results");
    const btn = document.getElementById("run-diag-btn");
    const queue = document.getElementById("diag-queue-input").value.trim() || "650";
    btn.disabled = true;
    grid.innerHTML = `<p class="muted">Ejecutando pruebas en vivo contra AMI, Cola ${escapeHtml(queue)}, ARI y EVA...</p>`;

    try {
      const res = await apiJson("/admin/api/diagnostics", {
        method: "POST",
        body: JSON.stringify({ queue }),
      });
      grid.innerHTML = (res.checks || [])
        .map(
          (check) => `
          <div class="diag-card">
            <div class="panel-head">
              <strong>${escapeHtml(check.title)}</strong>
              ${statusPill(check.status)}
            </div>
            <div class="muted">${escapeHtml(check.detail)}</div>
          </div>`
        )
        .join("");
    } catch (error) {
      grid.innerHTML = `<p class="alert alert-error">${escapeHtml(error.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  }

  function setupAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    const enabled = document.getElementById("auto-refresh-toggle").checked;
    if (enabled) {
      refreshTimer = setInterval(() => {
        if (activeTab === "dashboard") loadOverview();
        if (activeTab === "audit") loadAudit();
      }, 4000);
    }
  }

  document.getElementById("nav-tabs").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tab]");
    if (btn) switchTab(btn.dataset.tab);
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await apiJson("/admin/api/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/admin/login";
  });

  document.getElementById("refresh-now-btn").addEventListener("click", () => {
    if (activeTab === "dashboard") loadOverview();
    if (activeTab === "audit") loadAudit();
    if (activeTab === "config") loadConfig();
  });

  document.getElementById("auto-refresh-toggle").addEventListener("change", setupAutoRefresh);
  document.getElementById("flush-outbox-btn").addEventListener("click", async () => {
    await apiJson("/admin/api/outbox/flush", { method: "POST" });
    loadOverview();
  });
  document.getElementById("audit-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    loadAudit();
  });
  document.getElementById("config-form").addEventListener("submit", saveConfig);
  document.getElementById("credentials-form").addEventListener("submit", saveCredentials);
  document.getElementById("run-diag-btn").addEventListener("click", runDiagnostics);

  loadOverview();
  setupAutoRefresh();
})();

