# Ariana Asterisk

Servicio Node.js para llamadas troncales por Asterisk / FreePBX / Grandstream AMI.

Este proyecto queda separado de `ariana-voice`: `ariana-voice` maneja WhatsApp/WebRTC y este servicio maneja solo PBX/troncales.

## Flujo

```text
EVA -> Ariana Asterisk -> Asterisk/Grandstream AMI
Asterisk/Grandstream AMI -> Ariana Asterisk -> EVA
```

EVA debe apuntar la integracion `TRUNCAL.url` a la URL publica de este servicio.
El token de la integracion `TRUNCAL` debe ser el mismo de `ASTERISK_API_TOKEN` y `LARAVEL_API_TOKEN`.
Si EVA debe guardar la llamada en una base tenant, configura `LARAVEL_TENANT_DATABASE` con el nombre de esa base.

## Endpoints

- `GET /api/health`
- `GET /api/pbx/health`
- `GET /api/pbx/events`
- `GET /api/pbx/calls`
- `GET /api/pbx/ami/status`
- `GET /api/pbx/calls/:linkedid`
- `POST /api/pbx/calls/:linkedid/hangup`
- `POST /api/pbx/calls/:linkedid/connect-extension`
- `POST /api/pbx/originate/extension`
- `POST /api/pbx/originate/external`
- `POST /api/pbx/originate/direct`

Los endpoints `/api/pbx/*` usan `Authorization: Bearer <ASTERISK_API_TOKEN>`.

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

Probar callback hacia EVA sin llamada real:

```bash
npm run test:trunk-callback
```
# ariana-asterisk
