# Instructivo Cerrado de Despliegue y Operación: Issabel Hospitalario ➔ `ariana-asterisk v2` ➔ EVA Cloud

**Alcance:** Fases 5 (Pre-chequeo, Staging en Cola Espejo) y 6 (Pase a Producción Cola `650`, Rollback `< 2 min`, Monitoreo 72 h y Replicación Cliente X).  
**Importante:** Durante toda la **Fase 5** NO se modifica la Cola `650` ni el IVR en producción del Hospital.

---

## 1. Pre-requisitos Confirmados del Hospital (`Northospital` — Fase 5.1)

**Estado confirmado en sitio (18/11/2026):** **`Issabel 4.0.0`** + **`IssabelPBX 2.11.0-48`** + **`Asterisk 13.30.0`** (CentOS 7).

> **⚠️ Regla operativa:** **NO actualizar ni tocar la versión de Issabel 4 / Asterisk 13.30.0 en producción del Hospital** (CentOS 7 está en EOL; intentar subir a Asterisk 16/18 in-place rompe dependencias y dialplans, y migrar a Issabel 5 exige servidor nuevo con migración manual de contextos custom y cambio de puertos `5060`/`5066`).

1. **Modos compatibles sobre `Asterisk 13.30.0` (según Fase 4B):**
   * **Plan A — Navegador Chrome EVA sin softphone (`sip_bridge`, en certificación previa en Lab VM `13.22.0`):** `ariana-asterisk` conecta AMI directo al Issabel `13.30.0` y usa un contenedor satélite ligero (`asterisk-media-bridge` headless en nuestra caja Docker LAN) mediante 1 peer SIP interno (`< 1 ms` en LAN) para sacar audio por WebSocket hacia EVA.
   * **Plan B — Respaldo 0 riesgo / Teléfono IP, `MicroSIP` o `Zoiper` (`TRUNK_ANSWER_MODE=extension`):** audio SIP nativo en el Issabel `13.30.0` (`0 ms` delay); EVA controla toda la pantalla del agente, ficha CRM, estado automático `EN_LINEA` ↔ `OCUPADO` y pausas en Cola.
   * **En futuros clientes con `Asterisk 16.6+ / 18+ / 20+` (ej. Issabel 5):** se usa **`ari_media`** directo por `/ari/channels/externalMedia` sin `sip_bridge`.
2. **Servidor / Mini-PC en la LAN del Hospital (para `ariana-asterisk v2`):**
   * Red **Ethernet cableada** en la misma subred LAN (o ruta directa sin NAT estricto) que el Issabel.
   * **UPS** y plan de energía sin suspensión automática (`systemctl mask sleep.target suspend.target`).
   * Docker + Docker Compose v2 instalados *(en Linux producción se recomienda `network_mode: host` para evitar latencia/carga de `docker-proxy` en UDP RTP)*.
3. **Conectividad, SSL y Firewall:**
   * Dominio o DDNS con certificado SSL válido apuntando al gateway (`PUBLIC_BASE_URL`, ej. `https://pbx-hospital.dominio.com:366`) para que Chrome de los asesores abra `wss://.../366` sin bloqueos de certificado.
   * Puertos requeridos:
     * **LAN hacia Issabel:** TCP `5038` (AMI), TCP `8088` (ARI HTTP/WS), UDP `5060` (si se usa `sip_bridge` local) y UDP `46000-46200` (RTP bidireccional en LAN).
     * **Navegadores / EVA Cloud hacia Gateway:** TCP `366` (HTTPS/WSS con `nginx` proxy hacia `127.0.0.1:3002`).
     * **Gateway hacia EVA Cloud:** salida HTTPS `443` saliente (webhooks + heartbeat).

---

## 2. Instructivo para el Administrador del Issabel (4 Bloques Cerrados — Fase 5.2)

> Aplicar únicamente estos 4 bloques. **No tocar la Cola `650` ni las rutas actuales de IVR** durante Fase 5.

### Bloque A — `/etc/asterisk/http.conf`
```ini
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=8088
```

### Bloque B — `/etc/asterisk/ari.conf`
*(Reemplazar `CLAVE_ARI_SEGURA` por una clave fuerte única).*
```ini
[general]
enabled=yes
pretty=yes
allowed_origins=*

[ariana]
type=user
read_only=no
password=CLAVE_ARI_SEGURA
password_format=plain
```

### Bloque C — `/etc/asterisk/manager_custom.conf`
*(Reemplazar `IP_LAN_GATEWAY` por la IP fija del PC/Server Docker en la LAN y `CLAVE_AMI_SEGURA` por una clave fuerte).*
```ini
[middleware]
secret = CLAVE_AMI_SEGURA
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.0
permit = IP_LAN_GATEWAY/255.255.255.255
read = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan
write = system,call,log,verbose,command,agent,user,config,originate,reporting
```

### Bloque D — `/etc/asterisk/extensions_custom.conf` y Cola Espejo de Pruebas (`659`)
1. Agregar el contexto de puente de audio Stasis:
   ```ini
   [ariana-ari]
   exten => s,1,NoOp(Ariana ARI Bridge ${CALLERID(num)})
    same => n,Ringing()
    same => n,Stasis(ariana-trunk)
    same => n,Hangup()
   ```
2. Crear una **cola espejo de pruebas** (ej. `[659]` en `queues_custom.conf` o desde Issabel GUI) con 1–2 extensiones piloto (`101`, `102`), configurada para reparto limpio y sin doble timbre:
   * `strategy=rrmemory` *(o `leastrecent`; evitar `ringall` en producción)*
   * `ringinuse=no`
   * `wrapuptime=3`
   * `eventwhencalled=yes`
   * Timeout de cola holgado (ej. `180`–`300` s o música en espera sin cortar a los 30 s) y enrutar hacia esa cola **únicamente un DID de pruebas o una opción oculta de IVR** (tráfico bajo).

3. **Bloque E (Solo si operará Plan A `sip_bridge` en navegador sobre Issabel `13.30.0`):** habilitar 1 peer/troncal SIP interno sin salida externa apuntando a `IP_LAN_GATEWAY` (códecs `ulaw,alaw`, `nat=no`, `qualify=yes`) y su contexto de puente local según guía de Fase 4B.2. *(No requerido si se opera Plan B con MicroSIP/Zoiper/Teléfono IP).*

4. Recargar módulos en Issabel **sin cortar llamadas activas**:
   ```bash
   asterisk -rx "module reload manager"
   asterisk -rx "module reload res_ari.so"
   asterisk -rx "dialplan reload"
   asterisk -rx "queue reload all"
   asterisk -rx "http show status"
   asterisk -rx "ari show status"
   ```

---

## 3. Despliegue de `ariana-asterisk v2` en LAN y Verificación Autónoma (Fase 5.3)

1. Clonar/actualizar `ariana-asterisk` en `main` en el servidor LAN:
   ```bash
   cp .env.client.example .env
   # Editar CONFIG_MASTER_KEY y ADMIN_BOOTSTRAP_PASSWORD en .env
   mkdir -p ./data ./logs
   docker compose up -d --build
   ```
2. Entrar a `https://PUBLIC_BASE_URL/admin` desde el navegador, iniciar sesión y completar:
   * **EVA Destino:** `LARAVEL_API_URL` (`https://sigcrm.pro` o dominio EVA Cloud), `LARAVEL_TENANT_DATABASE` (BD del tenant), `LARAVEL_API_TOKEN` / `ASTERISK_API_TOKEN` (token de `integracions` código `TRUNCAL`), `PUBLIC_BASE_URL`.
   * **Issabel Local:** IP LAN de Issabel, AMI `5038` + `[middleware]`, ARI `http://IP_ISSABEL:8088` + `[ariana]`, `ARI_APP_NAME=ariana-trunk`, Contexto `ariana-ari`, Cola `659` (en Fase 5) ➔ luego `650` (en Fase 6), RTP `46000-46200`.
   * Clic en **Guardar y Reconectar en Caliente**.
3. En `/admin` ➔ **Diagnóstico en 1 Clic**, confirmar los **4 checks en verde**:
   * AMI Login OK
   * ARI WebSocket OK (`ariana-trunk`)
   * `QueueStatus` devolviendo miembros reales de la cola
   * `POST` test hacia EVA Cloud `200 OK`
4. En EVA Cloud ➔ **Dashboard de llamadas** confirmar la barra **Gateway Issabel** en verde (`AMI OK · ARI OK · Outbox 0 · RAM RSS MB`).

---

## 4. Prueba en Vivo en Cola Espejo (Fase 5.4 — 15 a 30 minutos)

Ejecutar antes de aprobar el pase a producción:
1. Llamar desde 2–3 celulares externos reales hacia el DID / opción oculta que apunta a la cola espejo `659`.
2. Verificar en EVA con 1–2 asesores piloto:
   * Timbrado inmediato en el Launcher y audio bidireccional claro en navegador.
   * Transferencia entre piloto 1 y piloto 2 sin corte ni llamada fantasma.
   * Abandono antes de contestar (`Espera` exacta, `ended_at` lleno, `Hablado = 0s`).
   * Grabación y transcripción registradas en `Dashboard de llamadas`.
   * Revisar **Caja Negra** en `/admin` (`0` rechazos AMI/ARI, `0` errores HTTP 4xx/5xx).

---

## 5. Pase a Producción (Cola `650`) y Plan de Rollback `< 2 min` (Fase 6)

### 5.1. Cambio controlado a Producción
1. En `/admin` cambiar **Cola por defecto** de `659` a **`650`** y pulsar **Guardar y Reconectar en Caliente**.
2. Validar `QueueStatus 650` en Diagnóstico 1-Clic con todos los asesores reales.
3. En el PBX / IVR del Hospital, apuntar la salida del IVR directo hacia la Cola `650` (eliminando el salto FreePBX intermedio si existía) y realizar 2 llamadas reales de humo.

### 5.2. Plan de Rollback (`< 2 min`)
Si ocurre una falla física de red/audio o incidente bloqueante durante el pase:
1. **En Issabel (30 s):** revertir en FreePBX/Issabel la ruta de salida del IVR hacia el destino previo (o pausar envío al flujo ARI) y ejecutar `asterisk -rx "dialplan reload"`.
2. **En EVA / Gateway (30 s):** en caso de contingencia en el bridge de navegador, mantener la atención directa por extensión física/softphone o detener temporalmente el contenedor (`docker compose stop api`) sin perder los registros del `./data/outbox.json`.
3. **Verificación post-rollback (30 s):** realizar 1 llamada de prueba entrante al `650` confirmando timbre normal por la ruta anterior.

### 5.3. Monitoreo 72 Horas y Replicación ("Cliente X")
* **Monitoreo 72 h (EVA Cloud + `/admin`):**
  * Revisar cada día en **Dashboard de llamadas** la barra de **Salud Gateway**: `Gateway En línea`, `AMI OK`, `ARI OK`, `Outbox 0`, `RAM RSS` estable (`< 150 MB`) y `Latencia webhook` normal (`< 400 ms`).
  * Comparar total de entrantes vs. atendidas/abandonadas y revisar `/app/data/audit/YYYY-MM-DD.jsonl` en `/admin`.
* **Replicación estándar "Cliente X":**
  * Misma imagen Docker `ariana-asterisk` (`main`), mismo `.env.client.example` de 6 variables, mismo volumen `./data:/app/data`, y alta guiada desde `/admin` + Diagnóstico en 1 Clic.

