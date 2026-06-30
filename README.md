# Ariana Asterisk

Servicio Node.js para llamadas troncales por Asterisk / FreePBX / Grandstream.

Este proyecto queda separado de `ariana-voice`: `ariana-voice` maneja WhatsApp/WebRTC y este servicio maneja PBX/troncales. AMI sigue disponible para eventos/control tradicional y ARI queda como base para el puente de audio humano/IA.

## Flujo

```text
EVA -> Ariana Asterisk -> Asterisk/Grandstream AMI
Asterisk/Grandstream AMI -> Ariana Asterisk -> EVA
```

Flujo ARI objetivo:

```text
Grandstream/Troncal -> Asterisk Stasis(ariana-trunk)
                         -> Ariana Asterisk ARI
                         -> EVA/Laravel decide humano o IA
                         -> bridge de audio navegador/IA/fallback SIP
```

EVA debe apuntar la integracion `TRUNCAL.url` a la URL publica de este servicio.
El token de la integracion `TRUNCAL` debe ser el mismo de `ASTERISK_API_TOKEN` y `LARAVEL_API_TOKEN`.
Si EVA debe guardar la llamada en una base tenant, configura `LARAVEL_TENANT_DATABASE` con el nombre de esa base.
Para que EVA use audio en navegador con ARI, configura el JSON de la integracion `TRUNCAL` con `{"answer_mode":"ari_media"}` o `{"pbx":{"answer_mode":"ari_media"}}`.

## Endpoints

- `GET /api/health`
- `GET /api/pbx/health`
- `GET /api/ari/health`
- `GET /api/ari/events`
- `GET /api/ari/sessions`
- `GET /api/ari/media-sessions`
- `GET /api/ari/ai-sessions`
- `GET /api/ari/calls/:linkedid`
- `POST /api/ari/calls/:linkedid/media-session`
- `POST /api/ari/calls/:linkedid/media-session/close`
- `POST /api/ari/calls/:linkedid/ai-session`
- `POST /api/ari/calls/:linkedid/ai-session/close`
- `POST /api/ari/calls/:linkedid/answer`
- `POST /api/ari/calls/:linkedid/bridge`
- `POST /api/ari/calls/:linkedid/play`
- `POST /api/ari/calls/:linkedid/hangup`
- `GET /api/ari/sessions/:channelId`
- `POST /api/ari/sessions/:channelId/answer`
- `POST /api/ari/sessions/:channelId/bridge`
- `POST /api/ari/sessions/:channelId/play`
- `POST /api/ari/sessions/:channelId/hangup`
- `GET /api/pbx/events`
- `GET /api/pbx/calls`
- `GET /api/pbx/ami/status`
- `GET /api/pbx/calls/:linkedid`
- `POST /api/pbx/calls/:linkedid/hangup`
- `POST /api/pbx/calls/:linkedid/connect-extension`
- `POST /api/pbx/originate/extension`
- `POST /api/pbx/originate/external`
- `POST /api/pbx/originate/direct`

Los endpoints `/api/pbx/*` y `/api/ari/*` usan `Authorization: Bearer <ASTERISK_API_TOKEN>`.

## ARI

La base ARI arranca apagada por defecto. Para la primera prueba en FreePBX/Asterisk:

1. Habilita HTTP/ARI en Asterisk.
2. Crea usuario ARI en `ari.conf`.
3. Configura `.env`:

```bash
ARI_ENABLED=true
ARI_BASE_URL=http://127.0.0.1:8088
ARI_USERNAME=ariana
ARI_PASSWORD=tu_password
ARI_APP_NAME=ariana-trunk
PUBLIC_BASE_URL=http://IP-O-DOMINIO-DEL-GATEWAY:366
ARI_EXTERNAL_MEDIA_HOST=127.0.0.1
ARI_EXTERNAL_MEDIA_BIND_HOST=0.0.0.0
ARI_EXTERNAL_MEDIA_PORT_START=46000
ARI_EXTERNAL_MEDIA_PORT_END=46100
ARI_EXTERNAL_MEDIA_FORMAT=ulaw
```

4. Crea una ruta/dialplan de prueba que mande la llamada a:

```asterisk
Stasis(ariana-trunk)
```

Si la llamada todavia entra a una extension como `107`, el gateway tambien puede rescatarla por AMI al presionar contestar en EVA y redirigirla a ARI. Para eso agrega este contexto en `/etc/asterisk/extensions_custom.conf`:

```asterisk
[ariana-ari]
exten => s,1,NoOp(Ariana ARI trunk ${CHANNEL(linkedid)})
 same => n,Answer()
 same => n,Stasis(ariana-trunk)
 same => n,Hangup()
```

Luego ejecuta:

```bash
fwconsole reload
```

Y deja estas variables en `.env`:

```bash
ARI_STASIS_REDIRECT_ENABLED=true
ARI_STASIS_CONTEXT=ariana-ari
ARI_STASIS_EXTENSION=s
ARI_STASIS_PRIORITY=1
ARI_STASIS_WAIT_MS=5000
ARI_BRIDGE_WAIT_MS=10000
```

5. Verifica estado:

```bash
curl -H "Authorization: Bearer $ASTERISK_API_TOKEN" http://localhost:366/api/ari/health
curl -H "Authorization: Bearer $ASTERISK_API_TOKEN" http://localhost:366/api/ari/sessions
```

Para probar control de una sesion ARI:

```bash
curl -X POST -H "Authorization: Bearer $ASTERISK_API_TOKEN" http://localhost:366/api/ari/sessions/<channelId>/answer
curl -X POST -H "Authorization: Bearer $ASTERISK_API_TOKEN" -H "Content-Type: application/json" -d "{\"media\":\"sound:demo-congrats\"}" http://localhost:366/api/ari/sessions/<channelId>/play
curl -X POST -H "Authorization: Bearer $ASTERISK_API_TOKEN" http://localhost:366/api/ari/calls/<linkedid>/answer
```

Para probar el puente de audio navegador/PBX, inicia una sesion de media por `linkedid`:

```bash
curl -X POST -H "Authorization: Bearer $ASTERISK_API_TOKEN" -H "Content-Type: application/json" -d "{\"agent_id\":1}" http://localhost:366/api/ari/calls/<linkedid>/media-session
```

La respuesta incluye `agentWebSocketUrl`. Ese WebSocket usa el mismo contrato de audio que EVA ya usa para llamadas humanas: PCM signed 16-bit little-endian a 48 kHz en ambos sentidos. Internamente Ariana convierte ese audio a RTP `ulaw` para Asterisk mediante ARI `ExternalMedia`.

Para probar el modo IA troncal, EVA debe iniciar `POST /api/ari/calls/<linkedid>/ai-session` cuando el canal esta en `ai_agent_transfer`. Para una prueba manual:

```bash
curl -X POST -H "Authorization: Bearer $ASTERISK_API_TOKEN" -H "Content-Type: application/json" -d "{\"agent_id\":1,\"channel\":\"trunk\",\"tools_base_url\":\"https://sigcrm.pro/api/voice-agent/tools\",\"realtime\":{\"instructions\":\"Responde breve en espanol.\"}}" http://localhost:366/api/ari/calls/<linkedid>/ai-session
curl -H "Authorization: Bearer $ASTERISK_API_TOKEN" http://localhost:366/api/ari/ai-sessions
```

Variables requeridas para IA:

```bash
TRUNK_AI_ENABLED=true
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_REALTIME_VOICE=marin
LARAVEL_VOICE_TOOLS_TOKEN=
```

`LARAVEL_VOICE_TOOLS_TOKEN` puede quedar vacio si EVA acepta `LARAVEL_API_TOKEN` para herramientas de voz; si tu instalacion mantiene un token separado para `VOICE_GATEWAY`, coloca ese token aqui. La sesion IA usa el puente RTP de ARI, no `ariana-voice`.

## Desarrollo

```bash
npm install
cp .env.example .env
npm run dev
```

## Docker

```bash
cp .env.example .env
docker compose up -d --build
```

Por defecto Docker publica el servicio en el puerto `366` del servidor:

```text
http://localhost:366/api/health
http://localhost:366/api/pbx/health
```

## Validacion

Verificar sintaxis:

```bash
npm run check
```

Verificar conexion AMI:

```bash
npm run check:pbx
```

Verificar conexion ARI:

```bash
npm run check:ari
```

Probar callback hacia EVA sin llamada real:

```bash
npm run test:trunk-callback
```
# ariana-asterisk
