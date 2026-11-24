# Instructivo Cerrado de Despliegue y Operación: Issabel Hospitalario ➔ `ariana-asterisk v2` ➔ EVA Cloud

**Alcance:** Fases 5 (Pre-chequeo, Staging en Cola Espejo) y 6 (Pase a Producción Cola `650`, Rollback `< 2 min`, Monitoreo 72 h y Replicación Cliente X).  
**Importante:** Durante toda la **Fase 5** NO se modifica la Cola `650` ni el IVR en producción del Hospital.

---

## 1. Pre-requisitos Confirmados del Hospital (`Northospital` — Fase 5.1)

**Estado confirmado en sitio (18/11/2026):** **`Issabel 4.0.0`** + **`IssabelPBX 2.11.0-48`** + **`Asterisk 13.30.0`** (CentOS 7).

> **⚠️ Regla operativa:** **NO actualizar ni tocar la versión de Issabel 4 / Asterisk 13.30.0 en producción del Hospital** (CentOS 7 está en EOL; intentar subir a Asterisk 16/18 in-place rompe dependencias y dialplans, y migrar a Issabel 5 exige servidor nuevo con migración manual de contextos custom y cambio de puertos `5060`/`5066`).

1. **Modos compatibles sobre `Asterisk 13.30.0` (según Fase 4B):**
   * **Plan A — Navegador Chrome EVA sin softphone (`sip_bridge`, certificado en vivo en Lab VM `13.22.0`):** `ariana-asterisk` conecta AMI directo al Issabel `13.30.0` y usa un contenedor satélite ligero (`asterisk-media-bridge` headless en nuestra caja Docker LAN) mediante 1 peer SIP interno (`< 1 ms` en LAN, puerto `5080`) para sacar audio por WebSocket hacia EVA (`< 1 s` desde clic en contestar) manteniendo estadísticas nativas de cola y CDR 1-a-1 en Issabel.
   * **Plan B — Respaldo 0 riesgo / Teléfono IP, `MicroSIP` o `Zoiper` (`TRUNK_ANSWER_MODE=extension`):** audio SIP nativo en el Issabel `13.30.0` (`0 ms` delay); EVA controla toda la pantalla del agente, ficha CRM, estado automático `EN_LINEA` ↔ `OCUPADO` y pausas en Cola.
   * **En futuros clientes con `Asterisk 16.6+ / 18+ / 20+` (ej. Issabel 5):** se usa **`ari_media`** directo por `/ari/channels/externalMedia` sin `sip_bridge`.
2. **Servidor / Mini-PC en la LAN del Hospital (para `ariana-asterisk v2`):**
   * Red **Ethernet cableada** en la misma subred LAN (o ruta directa sin NAT estricto) que el Issabel.
   * **UPS** y plan de energía sin suspensión automática (`systemctl mask sleep.target suspend.target`).
   * Docker + Docker Compose v2 instalados *(en Linux producción se recomienda `network_mode: host` para evitar latencia/carga de `docker-proxy` en UDP RTP)*.
3. **Conectividad, SSL y Firewall:**
   * Dominio o DDNS con certificado SSL válido apuntando al gateway (`PUBLIC_BASE_URL`, ej. `https://pbx-hospital.dominio.com:366`) para que Chrome de los asesores abra `wss://.../366` sin bloqueos de certificado.
   * Puertos requeridos:
     * **Gateway ➔ Issabel (LAN):** TCP `5038` (AMI), TCP `8088` (ARI HTTP/WS) y UDP `10000-20000` (RTP hacia Issabel).
     * **Issabel ➔ Gateway (LAN, Plan A `sip_bridge`):** UDP/TCP `5080` (peer SIP `[ariana-bridge-sip]`) y UDP `18000-18060` + `46000-46200` (RTP bidireccional del bridge).
     * **Navegadores / EVA Cloud hacia Gateway:** TCP `366` (HTTPS/WSS con `nginx` usando `docker/nginx/default.conf` del repo con `resolver 127.0.0.11` hacia `api:3002`; solo requiere montar `nginx/certs/fullchain.pem` y `nginx/certs/key.pem`, sin editar Nginx manualmente ni reiniciar SSL tras `--build`).
     * **Gateway hacia EVA Cloud:** salida HTTPS `443` saliente (webhooks + heartbeat).

---

## 2. Instructivo para el Administrador del Issabel (Bloques A–D + Bloque E `sip_bridge` — Fase 5.2)

> Aplicar únicamente estos bloques. **No tocar la Cola `650` ni las rutas actuales de IVR** durante Fase 5.

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
2. Crear una **cola espejo de pruebas** (ej. `[659]` en `queues_custom.conf` o desde Issabel GUI) con 1–2 extensiones piloto (`101`, `102`), configurada para reparto limpio, paralelo y sin doble timbre:
   * `strategy=rrmemory` *(o `leastrecent`; evitar `ringall` en producción)*
   * `autofill=yes` *(obligatorio para repartir llamadas simultáneas a múltiples asesores libres sin bloqueo cabeza de fila)*
   * `autopause=no` *(evita que un timeout sin contestar pause silenciosamente al asesor en Asterisk)*
   * `ringinuse=no`
   * `wrapuptime=3`
   * `eventwhencalled=yes`
   * `eventmemberstatus=yes`
   * Timeout de cola holgado (ej. `180`–`300` s o música en espera sin cortar a los 30 s) y enrutar hacia esa cola **únicamente un DID de pruebas o una opción oculta de IVR** (tráfico bajo).

3. **Bloque E (Solo si operará Plan A `sip_bridge` en navegador sobre Issabel `13.30.0`):** agregar el troncal SIP interno en `/etc/asterisk/sip_custom.conf` y el contexto de puente/timbrado web en `/etc/asterisk/extensions_custom.conf` *(No requerido si se opera Plan B con MicroSIP/Zoiper/Teléfono IP)*:

   En `/etc/asterisk/sip_custom.conf` *(reemplazar `IP_LAN_GATEWAY` por la IP fija del servidor Docker gateway en la LAN)*:
   ```ini
   [ariana-bridge-sip]
   type=peer
   host=IP_LAN_GATEWAY
   port=5080
   context=ariana-sip-bridge
   disallow=all
   allow=ulaw
   allow=alaw
   qualify=yes
   insecure=port,invite
   canreinvite=no
   directmedia=no
   nat=no
   ```

   En `/etc/asterisk/extensions_custom.conf`:
   ```ini
   [ariana-sip-bridge]
   exten => _X.,1,NoOp(Ariana SIP Media Bridge ${CALLERID(num)} -> ${EXTEN})
    same => n,ExecIf($["${ARIANA_AGENT_LEG}"="1"]?Set(CDR_PROP(disable)=1))
    same => n,Dial(SIP/ariana-bridge-sip/${EXTEN},60)
    same => n,Hangup()

   [ariana-web-agent]
   exten => _X.,1,NoOp(Ariana Web Agent Ring ext ${EXTEN} caller ${CALLERID(num)})
    same => n,Set(__ARIANA_AGENT_LEG=1)
    same => n,Set(CDR_PROP(disable)=1)
    same => n,Ringing()
    same => n,Wait(25)
    same => n,Hangup()
   ```
   *(Para timbrar en EVA sin softphone instalado, registrar miembro en cola como `Local/101@ariana-web-agent/n,0,Nombre Agente` o mantener `SIP/101` en modo Mixto. Al desactivar el CDR en la pata virtual `;2` y redirigir dicha pata al contestar en EVA, Issabel registra **1 sola fila CDR limpia por llamada** en `Destination = 650` —`ANSWERED` con la extensión real del agente o `NO ANSWER`—, **0 filas `FAILED 0s`** y estadísticas reales `C:/A:` en `queue show 650` para cuadrar 1 a 1 con EVA).*

4. Recargar módulos en Issabel **sin cortar llamadas activas**:
   ```bash
   asterisk -rx "module reload manager"
   asterisk -rx "module reload res_ari.so"
   asterisk -rx "sip reload"
   asterisk -rx "dialplan reload"
   asterisk -rx "queue reload all"
   asterisk -rx "http show status"
   asterisk -rx "ari show status"
   asterisk -rx "sip show peer ariana-bridge-sip"
   ```

---

## 3. Despliegue de `ariana-asterisk v2` en LAN y Verificación Autónoma (Fase 5.3)

1. Clonar/actualizar `ariana-asterisk` en `main` en el servidor LAN:
   ```bash
   cp .env.example .env
   # En .env (solo ~11 variables de arranque Docker): definir ADMIN_BOOTSTRAP_PASSWORD, SIP_BRIDGE_PUBLIC_IP (IP LAN Docker)
   # y descomentar COMPOSE_FILE=docker-compose.yml:docker-compose.ssl.yml + API_HOST_PORT=127.0.0.1:3002
   # (Nota: en servidores ya inicializados NO cambiar CONFIG_MASTER_KEY para no invalidar ./data/config.enc.json)
   mkdir -p ./data ./logs ./nginx/certs
   # Copiar los 2 archivos del certificado SSL en ./nginx/certs/fullchain.pem y ./nginx/certs/key.pem (sin editar Nginx)
   docker compose up -d --build
   ```
   *(Para futuras actualizaciones en el servidor, bastará un solo comando: `git pull && docker compose up -d --build` — sin `-f` ni `docker restart ariana-asterisk-ssl`.)*
2. Entrar a `https://PUBLIC_BASE_URL/admin` desde el navegador, iniciar sesión, **cambiar la contraseña temporal inicial** (en **Configuración PBX / EVA ➔ Credenciales Administrativas**) y completar *(todo se guarda cifrado AES-256-GCM en `./data/config.enc.json`, sin texto plano en `.env`)*:
   * **EVA Destino:** `LARAVEL_API_URL` (`https://sigcrm.pro` o dominio EVA Cloud), `LARAVEL_TENANT_DATABASE` (BD del tenant), `LARAVEL_API_TOKEN` / `ASTERISK_API_TOKEN` (token de `integracions` código `TRUNCAL`), `PUBLIC_BASE_URL`.
   * **Issabel Local:** IP LAN de Issabel, AMI `5038` + `[middleware]`, ARI `http://IP_ISSABEL:8088` + `[ariana]`, `ARI_APP_NAME=ariana-trunk`, Contexto `ariana-ari`, Cola `659` (en Fase 5) ➔ luego `650` (en Fase 6), RTP `46000-46200` y sección **SIP Media Bridge** habilitada (`sip_bridge` / `auto`).
   * **Voz IA & Grabación (sección 5):** `OpenAI API Key` (enmascarada/cifrada), `Modelo OpenAI Realtime` (`gpt-realtime`), `Voz OpenAI Realtime` (`marin`), `Grabación`, `Transcribir Audio` y `Analizar Grabación con IA`.
   * Clic en **Guardar y Reconectar en Caliente**.
3. En `/admin` ➔ **Diagnóstico en 1 Clic**, confirmar todos los checks en verde:
   * Configuración persistente `./data` OK
   * AMI Login + `QueueStatus` devolviendo miembros reales de la cola
   * ARI WebSocket OK (`ariana-trunk`) + versión Asterisk detectada
   * `POST` test hacia EVA Cloud `200 OK`
   * Almacenamiento `./data`, Outbox (`0` pendientes) y RTP OK
   * **SIP Media Bridge** conectado (`Asterisk 20`, contexto `ariana-sip-bridge`)
4. En EVA Cloud ➔ **Dashboard de llamadas** confirmar la barra **Gateway Issabel** en verde (`AMI OK · ARI OK · Bridge SIP: OK · Outbox 0 · RAM RSS MB`).

---

## 4. Prueba en Vivo en Cola Espejo (Fase 5.4 — 15 a 30 minutos)

Ejecutar antes de aprobar el pase a producción:
1. Llamar desde 2–3 celulares externos reales hacia el DID / opción oculta que apunta a la cola espejo `659`.
2. Verificar en EVA con 1–2 asesores piloto:
   * Timbrado inmediato en el Launcher v2 y audio bidireccional claro en navegador (`< 1 s` al contestar).
   * Transferencia entre piloto 1 y piloto 2 sin corte ni llamada fantasma.
   * Rechazo y abandono antes de contestar (`Espera` exacta, `ended_at` lleno, `Hablado = 0s`).
   * **Convivencia simultánea WhatsApp + Análogo (1-a-1):** si un asesor atiende una llamada de WhatsApp mientras suena la cola `659`, la llamada analógica NO lo interrumpe; apenas cuelga WhatsApp, la cola reintenta sobre su extensión (`AgentRingNoAnswer` + `dedupeKey` por intento de canal) y la llamada timbra de inmediato en EVA.
   * Grabación y transcripción registradas en `Dashboard de llamadas`.
   * **Cuadre 1-a-1 en `CDR Report` de Issabel (`Destination = 659`):** 1 fila limpia por llamada (`ANSWERED` con la extensión real del asesor o `NO ANSWER`), **`0` filas `FAILED 0s`**, **`0` filas `88xxxxxxxx`**, y estadísticas reales (`C:`/`A:`) en `asterisk -rx "queue show 659"`. *(Nota operativa de Issabel: si se usa el botón `Delete displayed CDR(s)` durante limpieza de pruebas, recargar siempre entrando por el menú izquierdo `Reports ➔ CDR Report` —nunca con `F5`—, porque Chrome reenvía el `POST` de borrado y elimina los CDR nuevos).*
   * **Caja Negra y Dashboard en `/admin`:** `0` rechazos AMI/ARI, `0` errores HTTP 4xx/5xx, y columna **`Canal PBX`** mostrando el canal exacto (`SIP/...` o `DAHDI/...`) con copia rápida y acción **`Colgar`** disponible ante canales pegados.

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
  * Revisar cada día en **Dashboard de llamadas** la barra de **Salud Gateway**: `Gateway En línea`, `AMI OK`, `ARI OK`, `Bridge SIP: OK`, `Outbox 0`, `RAM RSS` estable (`< 150 MB`) y `Latencia webhook` normal (`< 400 ms`).
  * Comparar total de entrantes vs. atendidas/abandonadas entre `CDR Report` de Issabel (`Destination = 650`) y EVA `/dashboard-calls`, y revisar `/app/data/audit/events-YYYY-MM-DD.jsonl` en `/admin` (incluyendo búsqueda por **`Canal PBX`** ante cualquier incidencia).
* **Replicación estándar "Cliente X" (mismo patrón en `ariana-asterisk` y `ariana-voice`):**
  * Misma imagen Docker (`main`), `.env.example` / `.env.client.example` mínimo, SSL opcional versionado en `docker/nginx/default.conf` + `docker-compose.ssl.yml` (solo copiar `fullchain.pem` y `key.pem` en `./nginx/certs/` sin editar archivos del repo), volumen `./data:/app/data` y alta guiada 100% desde `/admin` + Diagnóstico en 1 Clic.

