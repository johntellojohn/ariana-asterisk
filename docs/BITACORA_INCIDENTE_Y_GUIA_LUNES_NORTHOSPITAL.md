# Bitácora de Incidente (27/11/2026) y Guía de Continuidad para Trabajo Remoto — Northospital

> **Propósito:** Documento operativo autocontenido para retomar el lunes desde casa con total claridad sobre **qué ya se corrió y aprobó**, **qué se descubrió en la caída del viernes 27/11**, **cómo validar si TI del Hospital corrigió el enlace físico**, y **qué pruebas/pasos ejecutar a continuación** antes del pase a producción.

---

## 1. Mapa del Entorno (Referencia Rápida)

| Componente | Host / IP | Rol | Notas clave |
|---|---|---|---|
| **Host físico Windows** | `DESKTOP-AAAVRUJ` (`172.16.12.79/23`, MAC `D8-5E-D3-27-82-E5`) | Windows 10 `19045.6466` (`16 GB` RAM, `i5-10400`) con VirtualBox | Acceso por **AnyDesk**. NIC física: `Intel(R) Ethernet Connection (11) I219-V` (`e1dexpress` v`12.19.2.60`). |
| **VM Gateway** | `192.168.12.48` (`ubuntuserver24`) | `ariana-asterisk` v2 (`api` + `nginx` SSL puerto `366`) | Acceso SSH puerto `2223` (`tecnico`, vía VPN Sophos). URL externa: `https://northospital.com.ec:366`. |
| **VM Central Nueva** | `192.168.12.49` (`issabel5`) | Issabel 5 / Asterisk `20.12.0` (`PJSIP`, Cola `650`) | Acceso SSH puerto `22` (`root`) y Web `https://192.168.12.49`. Scripts: `/root/simular_rafaga.sh` y `/root/colgar_todas.sh`. |
| **Central Producción Hospital** | `192.168.10.241` | Issabel 4 / Asterisk `13.30.0` (producción actual) | **NO MODIFICAR.** Solo conectaremos la troncal PJSIP desde `192.168.12.49` en Fase 5. |
| **EVA Pre-producción** | `https://intelho.sigcrm.pro` | Tenant de pruebas (`sigcrm_intelho`) | Agentes de prueba: **Lizeth (`101`, agentId `2`)** y **Nadia (`150`, agentId `97`)**. |

---

## 2. Estado al Cierre del Viernes 27/11/2026 (Qué Ya Está Hecho y Aprobado)

### A. Software (`ariana-asterisk` y `EVA`) — Validado en Vivo
1. **Handshake `audio_config` (`ulaw`) corregido en EVA (`resources/js/calls/v2/trunk-audio.js`):**
   - Eliminó el envío prematuro en PCM16 (`bytes: 2048` / `stale RTP droppedTotal: 54`).
   - Verificado en vivo: **100% de llamadas contestadas inician en `codec: 'ulaw'`, `bytes: 160`**, `0` errores.
2. **Hangup atómico de 1 viaje (`ariana-asterisk` + `EVA`):**
   - `POST /api/ari/calls/:id/media-session/close` cierra RTP + cuelga canal ARI + despausa Cola `650` en **10–16 ms LAN** (`~1.36 KB`, en lugar de 3 viajes WAN y 31 KB de `events[]`).
   - Tiempo total *Clic Colgar ➔ Siguiente llamada timbrando en EVA*: bajó de **`2.90–3.74 s` ➔ `1.25–1.94 s`** (al nivel de Rechazar, con tono inmediato al reemplazar `hangupInFlight` global por `endingCallIdentity`).
3. **Despliegue Docker Compose limpio por `.env` (`ariana-asterisk`):**
   - `asterisk-media-bridge` migrado a `profiles: ["sip-bridge"]`.
   - En Issabel 5 basta `docker compose up -d --build` (levanta solo `api` + `nginx`, `sipBridge.enabled: false`, `effectiveAnswerMode: "ari_media"`).
4. **Prueba de estrés en gateway (`/root/simular_rafaga.sh 40 0.5`):**
   - En el gateway (`192.168.12.48`): **0 errores, 0 HTTP `4xx`/`5xx`, 0 fugas de sesiones/puertos** (`activeSessions: 0`, `media-sessions: 0`, `pbx.activeCallsCount: 0`).
   - `POST /media-session`: `45–58 ms`; `POST /media-session/close`: `10–16 ms`.
   - Únicos 2 avisos en 30 min: `stale RTP audio dropped { dropped: 1, droppedTotal: 1 }` (`20 ms`, comportamiento normal del buffer anti-latencia de `320 ms`; no es fallo).

### B. Blindaje Aplicado Hoy (`16:55`) en el Host Windows (`DESKTOP-AAAVRUJ`)
Se aplicó y verificó en `DESKTOP-AAAVRUJ` (sin errores, y luego se validó `/api/health = 200 OK`):
- Plan de energía cambiado de **Equilibrado** a **Alto rendimiento** (`8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c`).
- Desactivados: suspensión (`standby-timeout-ac 0`), hibernación (`hibernate-timeout-ac 0` + `powercfg /h off`), apagado de disco (`disk-timeout-ac 0`), monitor (`monitor-timeout-ac 0`) y ahorro PCIe (`SUB_PCIEXPRESS ASPM 0`).
- Zona horaria corregida de UTC a **`SA Pacific Standard Time` (`UTC-5`)**.
- En `Intel(R) Ethernet Connection (11) I219-V`:
  - Desmarcada la casilla **"Permitir que el equipo apague este dispositivo para ahorrar energía"**.
  - En *Opciones avanzadas*: desactivados **`Ethernet con uso eficiente de energía (EEE)`**, **`Modo de Energía ultrabaja (ULPMode)`** y **`Reducir velocidad al apagar`**.
  - **Velocidad y dúplex** se dejó intencionalmente en **`Negociación automática`** (no forzar `1 Gbps` hasta que TI cambie cable/puerto).

---

## 3. Qué Pasó en el Incidente del Viernes 27/11 (Evidencia Forense)

### Causa raíz confirmada
**No fue fallo de EVA, `ariana-asterisk`, Issabel 5 ni VPN Sophos.** Fue una caída de **Capa 1 (enlace físico Ethernet)** en el equipo anfitrión del Hospital (`DESKTOP-AAAVRUJ`):

- **14:52:35 ➔ 15:48:06 (55 min 31 s):** `e1dexpress Event ID 27 (Network link is disconnected)` en `Intel(R) Ethernet Connection (11) I219-V`. Durante ese lapso Windows y Ubuntu siguieron encendidos, pero sin red (murió AnyDesk, VPN/SSH y DNS de Docker).
- **15:48:06 ➔ 15:48:42:** TI del Hospital intervino; el enlace físico volvió a **`100 Mbps full duplex`** (`Event ID 33`), recuperando AnyDesk.
- **15:48:42 ➔ 16:13:** Las VMs continuaron sin red hasta ser reiniciadas (`issabel5` `16:13:00`, `ubuntuserver24` `16:13:38`), porque la NIC virtual antigua **`e1000`** de `ubuntuserver24` en VirtualBox Bridged se traba tras un `link down` prolongado del host.

### Patrón histórico de los últimos 30 días (Visor de Eventos `System`)
- **11 caídas de enlace físico (`Event ID 27`)** entre el `27/10/2026` y el `27/11/2026` (incluyendo **57 min** sin enlace el `05/11` de `13:32` a `14:29`, y **55 min** hoy `27/11` de `14:52` a `15:48`).
- **Degradación de velocidad:** el **`05/11`** el enlace negociaba a **`1 Gbps full duplex`** (`Event ID 32`); desde el **`24/11`** cayó a **`100 Mbps full duplex`** (`Event ID 33`) y aumentaron los microcortes (síntoma clásico de cable UTP/RJ45 dañado o puerto de switch defectuoso).
- **Apagado brusco:** el **`26/11` a las `12:53:40`** el host registró **`Event ID 6008` + `Kernel-Power 41`** (corte eléctrico o falta de UPS / cuelgue).
- **Por qué AnyDesk iba muy lento a ratos:** combinación de pérdida de paquetes por el enlace degradado a `100 Mbps` + poca RAM libre en Windows (`ubuntuserver24` `9 GB` + `issabel5` `5 GB` = `14 GB` ocupados de `16 GB` físicos).

### Qué quedó solicitado a TI del Hospital (Richard Altamirano)
1. Reemplazar el **patch cord UTP** y/o cambiar de **puerto Gigabit en el switch** para `DESKTOP-AAAVRUJ` (`MAC D8-5E-D3-27-82-E5`) hasta recuperar **`1 Gbps full duplex`**.
2. Confirmar que el equipo esté conectado a **UPS operativo**.
3. Evaluar **reserva DHCP o IP fija** para el host Windows (`172.16.12.79`).

---

## 4. Guía Paso a Paso para el Lunes Desde Casa

### Bloque 1 — Verificar si TI del Hospital resolvió el enlace físico (2 minutos)

> Haz esto primero el lunes (y vuelve a correrlo apenas Richard confirme el cambio de cable/puerto).

#### 1.1 Verificar salud remota del gateway (desde tu PC en casa, sin necesidad de VPN ni AnyDesk)
Abre PowerShell o navegador y consulta:
```powershell
curl.exe -s https://northospital.com.ec:366/api/health -H "Authorization: Bearer <BEARER_TOKEN>"
```
- **Esperado:** `"status":"healthy"`, `"ari":{"connected":true,"lastError":null}`, `"pbx":{"connected":true,"lastAmiError":null}`, `"effectiveAnswerMode":"ari_media"`.

#### 1.2 Verificar en `DESKTOP-AAAVRUJ` (por AnyDesk ➔ abrir **CMD**)
Ejecuta estos 3 comandos en `C:\Users\PC>`:

1. **Velocidad de enlace + propiedades de energía de la NIC:**
   ```bat
   powershell -NoProfile -Command "Get-NetAdapter -Name 'Ethernet' | Format-Table Name,Status,LinkSpeed,DriverVersion -AutoSize; Get-NetAdapterAdvancedProperty -Name 'Ethernet' | Where-Object {$_.RegistryKeyword -in 'EEELinkAdvertisement','ULPMode','ReduceSpeedOnPowerDown','*SpeedDuplex'} | Format-Table DisplayName,DisplayValue -AutoSize"
   ```
2. **Confirmar que NO hubo nuevas caídas desde el viernes `27/11 17:00`:**
   ```bat
   wevtutil qe System /c:15 /rd:true /f:text "/q:*[System[Provider[@Name='e1dexpress'] or EventID=41 or EventID=6008]]"
   ```
3. **Prueba rápida de estabilidad LAN/Internet (`0%` pérdida de paquetes):**
   ```bat
   ping -n 30 172.16.12.1 && ping -n 30 8.8.8.8
   ```

#### Criterios de aprobación del Bloque 1
| Verificación | Aprobado (Listo) | Si falla / Qué significa |
|---|---|---|
| `LinkSpeed` de `Ethernet` | **`1 Gbps`** | Sigue en `100 Mbps`: aún no cambiaron cable/puerto o el puerto del switch es FastEthernet 100M. |
| `EEE` / `ULPMode` / `ReduceSpeedOnPowerDown` | Todos **Desactivado / Deshabilitado** | Volver a desactivarlos en *Administrador de dispositivos*. |
| Nuevos `Event ID 27` posteriores al `27/11 17:00` | **0 eventos** | Si aparecen nuevos `ID 27` con el ahorro de energía ya apagado, confirma **100% falla física de cable, puerto de switch o tarjeta NIC**. |
| Nuevos `Event ID 41 / 6008` posteriores al `26/11` | **0 eventos** | Si hubo otro apagado brusco, revisar UPS / RAM antes de producción. |
| Pérdida en `ping` | **`0% perdidos`** y latencia estable (`< 2 ms` al gateway) | Si hay pérdida de paquetes en `172.16.12.1`, persiste daño físico en cable/switch. |

---

### Bloque 2 — Evidenciar y corregir el toast rojo de WebSocket en EVA (15–20 minutos)

#### Qué ya está descubierto y reproducido localmente
Durante la ráfaga de `40 0.5` salió un **toast rojo de WebSocket en Lizeth (`101`)**. En auditoría de código en EVA se identificaron **4 bugs reales de concurrencia** (el #1 ya fue reproducido determinísticamente en Node contra `trunk-audio.js` sin modificar: al colgar a los `74 ms` mientras el WS está en `CONNECTING`, a los `6023 ms` dispara `"Tiempo agotado conectando audio WebSocket."`):

1. **`eva/resources/js/calls/v2/trunk-audio.js` (`teardownSession` / `connect`):** al cerrar una sesión mientras `ws` está abriendo, no limpia `openTimeout` (6 s) ni cancela la promesa ➔ traba `answeringLock` 6 segundos, dispara toast rojo a los 6 s, llama `abortTrunkMediaSession` sobre una llamada ya colgada, y su `catch` llama `teardownSession(false)` sin verificar si ya hay otra llamada activa.
2. **`eva/resources/js/calls/v2/launcher-v2.js`:** doble toast rojo cuando `acceptCall` ya falló (PHP + `notifyRtcError`), falta lock anti-doble clic en `Colgar`, y uso de `active.id` en vez de `callId` del botón.
3. **`eva/app/Services/Calls/CallLauncherV2ActionService.php`:** carrera multi-agente cuando `agentringnoanswer` rota una llamada de Lizeth a Nadia (y peligro de `orWhereNull('assigned_agent_id')` en `reject()` que puede colgar al paciente mientras espera en cola).

#### Prueba en vivo opcional (Opción A — 2 minutos) para evidenciarlo antes de aplicar el fix
1. Confirmar a **Lizeth (`101`)** y **Nadia (`150`)** en **Disponible** en `https://intelho.sigcrm.pro`.
2. En la pestaña de **Lizeth (`101`)**, abrir **F12 ➔ Console**, limpiar (`Ctrl+L`) y pegar el **Medidor v2**:

```js
(() => {
  if (window.__cc2ProbeV2) return console.log('Medidor v2 ya activo');
  window.__cc2ProbeV2 = true;
  const rows = [];
  const t0 = performance.now();
  const root = () => document.querySelector('[data-call-launcher-v2-root]');
  const readActive = () => {
    try { return JSON.parse(root()?.querySelector('[data-cc2-active-call]')?.textContent || 'null'); } catch { return null; }
  };
  const log = (ev, detail = {}) => {
    const row = { ts: new Date().toISOString().slice(11, 23), ms: Math.round(performance.now() - t0), ev, ...detail };
    rows.push(row);
    console.log(`[CC2-V2 ${row.ts} +${row.ms}ms] ${ev}`, detail);
  };
  window.__cc2ProbeDump = () => JSON.stringify(rows, null, 2);

  document.addEventListener('click', (e) => {
    const rej = e.target?.closest?.('[data-cc2-reject-btn]');
    if (rej) log('CLICK_REJECT', { active: readActive()?.identity, btnId: rej.dataset.callId });
    const hng = e.target?.closest?.('[data-cc2-hangup-btn], [data-cc2-banner-hangup-btn]');
    if (hng) log('CLICK_HANGUP', { active: readActive()?.identity, btnId: hng.dataset.callId });
    const ans = e.target?.closest?.('[data-cc2-answer-click]');
    if (ans) log('CLICK_ANSWER', { active: readActive()?.identity, btnId: ans.dataset.callId });
  }, true);

  window.addEventListener('showToast', (e) => {
    const d = Array.isArray(e.detail) ? (e.detail[0] || {}) : (e.detail || {});
    log('TOAST', { cls: d.class || d.type || '?', msg: d.message || d.text || '' });
  });

  const OrigWS = window.WebSocket;
  window.WebSocket = class extends OrigWS {
    constructor(url, protocols) {
      super(url, protocols);
      const s = String(url || '');
      if (s.includes('/agent-ws')) {
        const id = (s.match(/\/calls\/([^/]+)\//) || [])[1] || '?';
        const st = performance.now();
        log('WS_CREATE', { id });
        this.addEventListener('open', () => log('WS_OPEN', { id, openMs: Math.round(performance.now() - st) }));
        this.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string' && ev.data.includes('audio_config')) {
            log('WS_AUDIO_CFG', { id, ms: Math.round(performance.now() - st) });
          }
        });
        this.addEventListener('error', () => log('WS_ERR', { id, ms: Math.round(performance.now() - st) }));
        this.addEventListener('close', (ev) => log('WS_CLOSE', { id, code: ev.code, reason: ev.reason, clean: ev.wasClean, ms: Math.round(performance.now() - st) }));
      }
    }
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url || '');
    if (!url.includes('/livewire/update')) return origFetch(input, init);
    let calls = [];
    try {
      const parsed = JSON.parse(init?.body || '{}');
      for (const c of (parsed.components || [])) {
        for (const call of (c.calls || [])) {
          const arg0 = call.params?.[0];
          calls.push(call.method + (arg0 !== undefined ? '(' + String(arg0).slice(0, 40) + ')' : ''));
        }
      }
    } catch {}
    const s = performance.now();
    const label = calls.join(',') || 'refresh';
    log('LW_START', { calls: label });
    try {
      const res = await origFetch(input, init);
      log('LW_DONE', { calls: label, status: res.status, durMs: Math.round(performance.now() - s) });
      return res;
    } catch (err) {
      log('LW_ERR', { calls: label, durMs: Math.round(performance.now() - s), err: err?.message });
      throw err;
    }
  };

  const r = root();
  if (window.Echo && r?.dataset?.empresaId && r?.dataset?.agentId) {
    window.Echo.channel(`trunk.calls.${r.dataset.empresaId}.${r.dataset.agentId}`)
      .listen('TrunkCallRealtimeEvent', (e) => {
        const p = e?.payload || {};
        log('ECHO_EVENT', { id: p.id, extId: p.external_call_id, status: p.status, event: p.event, agent: p.assigned_agent_id });
      });
  }

  let lastSig = '';
  if (window.Livewire?.hook) {
    window.Livewire.hook('morph.updated', () => {
      const a = readActive();
      const sig = a ? `${a.identity}|${a.status}|ans=${a.is_answered}` : 'NONE';
      if (sig !== lastSig) {
        lastSig = sig;
        log('UI_ACTIVE_CHANGED', { sig });
      }
    });
  }
  log('PROBE_V2_READY', { agent: r?.dataset?.agentId, active: readActive()?.identity || 'NONE' });
})();
```

3. Desde `192.168.12.49` (SSH `root`) correr:
   - **Caso 1 (Contestar ➔ Colgar inmediato < 0.5 s):** `/root/simular_rafaga.sh 2 1` (colgar la 1ª inmediato, intentar contestar la 2ª y esperar 7 s).
   - **Caso 2 (Doble clic rápido en Colgar):** `/root/simular_rafaga.sh 1 1`.
   - **Caso 3 (Rotación Lizeth ➔ Nadia a los ~15 s):** `/root/simular_rafaga.sh 1 1`.
   - **Caso 4 (Mini-ráfaga rápida):** `/root/simular_rafaga.sh 10 0.5`.
4. Extraer resultados compactos:
   - En Console de Lizeth: `copy(window.__cc2ProbeDump())`
   - En `192.168.12.48` (`/opt/ariana-asterisk`):
     ```bash
     docker compose logs --since 10m api | grep -iE "error|warn|fail|timeout|dropped|stale|orphan| 4[0-9]{2} | 5[0-9]{2} |1008|agent websocket"
     ```
5. Aplicar los 3 arreglos limpios en EVA (con pruebas Node ESM + PHPUnit) y volver a pasar la prueba en vivo confirmando **0 toasts rojos**.

---

### Bloque 3 — Resiliencia del Host y VMs en `DESKTOP-AAAVRUJ` (Ventana de ~5 min)

*(Hacerlo cuando no haya pruebas activas porque apaga `ubuntuserver24` ~2 minutos).*
1. Apagar limpiamente `ubuntuserver24` (`sudo poweroff` desde SSH).
2. En VirtualBox (`DESKTOP-AAAVRUJ`):
   - **RAM `ubuntuserver24`:** bajar de **`9 GB ➔ 4 GB`** (libera 5 GB a Windows/AnyDesk).
   - **Red `ubuntuserver24`:** cambiar adaptador de **`Intel PRO/1000 (e1000)` ➔ `Adaptador paravirtualizado (virtio-net)`** (evita que la VM quede trabada tras un parpadeo del switch).
   - Verificar que la VM **`debian`** sin uso quede apagada.
3. Encender `ubuntuserver24` y validar `https://northospital.com.ec:366/api/health` (`200 OK`).
4. Configurar **autoarranque headless** de `issabel5` y `ubuntuserver24` en Programador de tareas de Windows al arrancar el equipo (sin esperar inicio de sesión) + **watchdog de red ligero en Ubuntu** (si pierde ping a la puerta de enlace por 60 s seguidos, reinicia su interfaz automáticamente).

---

### Bloque 4 — Cierre de Certificación Issabel 5, Troncal Hospital y Cutover (Fase 5 y 6)

Seguir el detalle completo en [INSTRUCTIVO_ISSABEL_HOSPITAL_FASE5_Y_6.md](./INSTRUCTIVO_ISSABEL_HOSPITAL_FASE5_Y_6.md):

1. **Issabel 5 GUI (`https://192.168.12.49`):**
   - Revisar `Reports ➔ CDR Reports` (verificar registros `ANSWERED` limpios).
   - Cambiar Cola `650` `Max Wait Time` de `Unlimited` ➔ **`5 minutes`**.
   - Probar **1 transferencia (`101 ➔ 150`)** y **1 llamada saliente**.
2. **Troncal PJSIP al Hospital (`800 ➔ 192.168.10.241:5060`):**
   - Crear visualmente en Issabel 5 (`PBX ➔ Trunks`, `Inbound Routes`, `Outbound Routes`) **sin tocar `192.168.10.241`**.
   - Validar `Registered`, CallerID real, llamada `> 2 min` y `3–5` llamadas simultáneas.
3. **Fase 5.3B — Monitor Forense de Red y Cortes:**
   - Implementar sonda de 3 puntos (`Asterisk LAN`, `Puerta de enlace`, `Internet/EVA`) con outbox offline en `ariana-asterisk` + tabla/panel `trunk_gateway_incidents` en EVA.
4. **Cutover a Producción (Fase 5.4 y Fase 6):**
   - Cambiar en `/admin` de `192.168.12.48` la `URL Pública` a `https://northospital.com.ec:366` y apuntar al tenant de Northospital (`sigcrm_clinmeydsa`).
   - Restaurar `sigcrm_intelho` (`id = 16`) de vuelta a `sigcenter.ddns.net:366`.
   - Piloto supervisado de 15–30 min ➔ paso oficial de Cola `650` y seguimiento de 72 h.

---

## 5. Comandos Rápidos de Diagnóstico (Referencia Express)

- **Estado de Cola `650` sin entrar por SSH:**
  ```powershell
  curl.exe -s https://northospital.com.ec:366/api/pbx/queue/status/650 -H "Authorization: Bearer <BEARER_TOKEN>"
  ```
- **Verificar sesiones activas/zombis en gateway:**
  ```powershell
  curl.exe -s https://northospital.com.ec:366/api/ari/media-sessions -H "Authorization: Bearer <BEARER_TOKEN>"
  ```
- **Ver errores del gateway en la última hora (`192.168.12.48`):**
  ```bash
  cd /opt/ariana-asterisk && docker compose logs --since 1h api | grep -iE "error|warn|fail|timeout|dropped|stale|orphan| 4[0-9]{2} | 5[0-9]{2} "
  ```
- **Limpiar llamadas simuladas si quedan en cola (`192.168.12.49`):**
  ```bash
  /root/colgar_todas.sh
  ```

