const crypto = require("crypto");
const WebSocket = require("ws");

const env = require("../../config/env");
const ariMediaService = require("./ari-media.service");
const { resamplePcm16 } = require("./pcm-utils");
const { callTool } = require("../laravel/voice-agent-tools.service");

const ASTERISK_PCM_RATE = 48000;

const aiSessionsById = new Map();
const aiSessionsByLinkedId = new Map();

async function startAiSessionByLinkedId(linkedid, payload = {}) {
    ensureAiEnabled();

    const targetLinkedid = String(linkedid || "").trim();

    if (!targetLinkedid) {
        const error = new Error("linkedid is required");
        error.status = 422;
        throw error;
    }

    const existing = aiSessionsByLinkedId.get(targetLinkedid);

    if (existing && !existing.closedAt) {
        console.log("[ari:ai] existing ai-session reused", {
            linkedid: targetLinkedid,
            sessionId: existing.id,
            status: existing.status,
            mediaSessionId: existing.mediaSessionId,
        });

        return snapshotAiSession(existing);
    }

    const session = createAiSession(targetLinkedid, payload);
    aiSessionsById.set(session.id, session);
    aiSessionsByLinkedId.set(targetLinkedid, session);

    console.log("[ari:ai] starting realtime trunk session", {
        linkedid: session.linkedid,
        sessionId: session.id,
        agentId: session.agentId,
        tenant: session.tenant,
        model: session.model,
        voice: session.voice,
        language: session.language,
        hasInitialGreeting: Boolean(session.initialGreeting),
    });

    try {
        console.log("[ari:ai] connecting OpenAI realtime websocket", {
            linkedid: session.linkedid,
            sessionId: session.id,
            model: session.model,
        });

        await connectRealtime(session);

        console.log("[ari:ai] OpenAI realtime websocket ready, starting ARI media", {
            linkedid: session.linkedid,
            sessionId: session.id,
        });

        const mediaSession = await ariMediaService.startMediaSessionByLinkedId(
            targetLinkedid,
            {
                owner: "ai",
                agentId: session.agentId,
                onAsteriskPcm48: (pcm48) => handleAsteriskAudio(session, pcm48),
                onClose: () => {
                    closeAiSession(session.id, "media_session_closed", {
                        closeMedia: false,
                    }).catch((error) => {
                        console.warn("[ari:ai] close after media end failed", {
                            linkedid: session.linkedid,
                            message: error.message,
                        });
                    });
                },
            }
        );

        session.mediaSessionId = mediaSession.id || null;
        session.status = "active";
        session.updatedAt = new Date().toISOString();

        console.log("[ari:ai] realtime trunk session active", {
            linkedid: session.linkedid,
            sessionId: session.id,
            mediaSessionId: session.mediaSessionId,
            agentId: session.agentId,
        });

        return snapshotAiSession(session);
    } catch (error) {
        session.lastError = error.message;
        session.status = "failed";
        session.updatedAt = new Date().toISOString();

        console.warn("[ari:ai] realtime trunk session start failed", {
            linkedid: session.linkedid,
            sessionId: session.id,
            message: error.message,
            status: error.status || null,
        });

        await closeAiSession(session.id, "start_failed").catch(() => {});

        throw error;
    }
}

async function closeAiSession(idOrLinkedid, reason = "closed", options = {}) {
    const session = getMutableSession(idOrLinkedid);

    if (!session) {
        return null;
    }

    if (!session.closedAt) {
        session.status = "closed";
        session.closedAt = new Date().toISOString();
        session.closeReason = reason;
        session.updatedAt = session.closedAt;

        if (session.realtimeSocket && session.realtimeSocket.readyState !== WebSocket.CLOSED) {
            session.realtimeSocket.close(1000, reason);
        }

        session.realtimeSocket = null;
        session.realtimeReady = false;

        if (options.closeMedia !== false && session.mediaSessionId) {
            await ariMediaService.closeMediaSession(session.mediaSessionId, reason);
        }
    }

    aiSessionsById.delete(session.id);
    aiSessionsByLinkedId.delete(session.linkedid);

    return snapshotAiSession(session);
}

function getAiSession(idOrLinkedid) {
    const session = getMutableSession(idOrLinkedid);

    return session ? snapshotAiSession(session) : null;
}

function listAiSessions() {
    return Array.from(aiSessionsById.values()).map(snapshotAiSession);
}

function createAiSession(linkedid, payload = {}) {
    const now = new Date().toISOString();
    const realtime = payload.realtime || {};

    return {
        id: crypto.randomUUID(),
        linkedid,
        status: "created",
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        closeReason: null,
        mediaSessionId: null,
        agentId: payload.agent_id || payload.agentId || null,
        tenant: payload.tenant || null,
        callbackUrl: payload.callback_url || payload.callbackUrl || null,
        toolsBaseUrl: payload.tools_base_url || payload.toolsBaseUrl || null,
        model: realtime.model || payload.model || env.openaiRealtimeModel,
        voice: realtime.voice || payload.voice || env.openaiRealtimeVoice,
        language: realtime.language || payload.language || env.trunkAiLanguage,
        instructions: realtime.instructions || payload.instructions || defaultInstructions(),
        turnDetection: realtime.turn_detection || payload.turn_detection || null,
        initialGreeting: normalizeText(payload.initial_greeting || payload.initialGreeting),
        initialGreetingPending: Boolean(normalizeText(payload.initial_greeting || payload.initialGreeting)),
        initialGreetingRequested: false,
        realtimeSocket: null,
        realtimeReady: false,
        asteriskAudioReady: false,
        outputActive: false,
        currentResponseId: null,
        currentAssistantItemId: null,
        inputFramesSent: 0,
        outputFramesSent: 0,
        toolCalls: 0,
        transcriptsSaved: 0,
        lastError: null,
    };
}

async function connectRealtime(session) {
    const url = new URL("wss://api.openai.com/v1/realtime");
    url.searchParams.set("model", session.model);

    session.realtimeSocket = new WebSocket(url, {
        headers: {
            Authorization: `Bearer ${env.openaiApiKey}`,
        },
    });

    session.realtimeSocket.on("message", (message) => {
        let event = null;

        try {
            event = JSON.parse(message.toString());
        } catch (error) {
            session.lastError = error.message;
            return;
        }

        handleRealtimeEvent(session, event);
    });

    session.realtimeSocket.on("error", (error) => {
        session.lastError = error.message;
        console.warn("[ari:ai] realtime websocket error", {
            linkedid: session.linkedid,
            message: error.message,
        });
    });

    session.realtimeSocket.on("close", (code, reasonBuffer) => {
        session.realtimeReady = false;

        if (!session.closedAt) {
            session.lastError = `realtime socket closed ${code}`;
            console.warn("[ari:ai] realtime websocket closed", {
                linkedid: session.linkedid,
                code,
                reason: reasonBuffer ? reasonBuffer.toString() : "",
            });
        }
    });

    await waitForOpenSocket(session.realtimeSocket, env.trunkAiRealtimeConnectTimeoutMs);

    const sessionUpdated = waitForRealtimeSessionUpdated(
        session.realtimeSocket,
        env.trunkAiRealtimeConnectTimeoutMs
    );

    sendRealtimeEvent(session, {
        type: "session.update",
        session: sessionConfig(session),
    });

    await sessionUpdated;

    session.realtimeReady = true;
    session.status = "realtime_ready";
    session.updatedAt = new Date().toISOString();
}

function sessionConfig(session) {
    return {
        type: "realtime",
        model: session.model,
        instructions: session.instructions,
        output_modalities: ["audio"],
        audio: {
            input: {
                format: {
                    type: "audio/pcm",
                    rate: env.trunkAiInputSampleRate,
                },
                transcription: {
                    model: env.openaiRealtimeTranscriptionModel,
                    language: session.language,
                },
                turn_detection: session.turnDetection || {
                    type: "server_vad",
                    threshold: env.trunkAiVadThreshold,
                    prefix_padding_ms: 300,
                    silence_duration_ms: env.trunkAiTurnSilenceMs,
                    create_response: true,
                    interrupt_response: true,
                },
            },
            output: {
                format: {
                    type: "audio/pcm",
                    rate: env.trunkAiOutputSampleRate,
                },
                voice: session.voice,
            },
        },
        tools: tools(),
        tool_choice: "auto",
        parallel_tool_calls: false,
    };
}

function tools() {
    return [
        functionTool("get_agent_context", "Obtiene contexto vigente de agente, llamada y configuracion.", {
            type: "object",
            properties: {},
            additionalProperties: false,
        }),
        functionTool("search_knowledge", "Busca fragmentos reales en la base de conocimiento del agente.", {
            type: "object",
            properties: {
                query: { type: "string" },
                limit: { type: "integer" },
            },
            required: ["query"],
            additionalProperties: false,
        }),
        functionTool("search_customer", "Consulta el cliente asociado a la llamada.", {
            type: "object",
            properties: {},
            additionalProperties: false,
        }),
        functionTool("check_availability", "Consulta disponibilidad real de agenda.", {
            type: "object",
            properties: {
                fecha: { type: "string" },
                dia_semana: { type: "string" },
                hora: { type: "string" },
                trabajador_id: { type: "integer" },
            },
            additionalProperties: false,
        }),
        functionTool("create_appointment", "Crea una cita solo si el cliente confirmo explicitamente.", {
            type: "object",
            properties: {
                fecha_hora: { type: "string" },
                opcion_id: { type: "string" },
                trabajador_id: { type: "integer" },
            },
            additionalProperties: true,
        }),
        functionTool("list_appointments", "Lista citas existentes del cliente asociado a la llamada.", {
            type: "object",
            properties: {
                solo_futuras: { type: "boolean" },
            },
            additionalProperties: false,
        }),
        functionTool("save_call_event", "Guarda transcript o evento relevante de la llamada.", {
            type: "object",
            properties: {
                role: { type: "string" },
                text: { type: "string" },
                event: { type: "string" },
            },
            required: ["role", "text"],
            additionalProperties: true,
        }),
    ];
}

function handleAsteriskAudio(session, pcm48) {
    if (session.closedAt || !session.realtimeReady || !pcm48 || !pcm48.length) {
        return;
    }

    session.asteriskAudioReady = true;

    if (session.initialGreetingPending && !session.initialGreetingRequested) {
        requestInitialGreeting(session);
        return;
    }

    const pcmInput = resamplePcm16(
        pcm48,
        ASTERISK_PCM_RATE,
        env.trunkAiInputSampleRate
    );

    if (!pcmInput.length) {
        return;
    }

    sendRealtimeEvent(session, {
        type: "input_audio_buffer.append",
        audio: pcmInput.toString("base64"),
    });

    session.inputFramesSent += 1;
    session.updatedAt = new Date().toISOString();
}

function handleRealtimeEvent(session, event) {
    if (!event || session.closedAt) {
        return;
    }

    switch (event.type) {
        case "session.updated":
            session.realtimeReady = true;
            break;
        case "response.created":
            session.currentResponseId = event.response?.id || null;
            session.outputActive = true;
            break;
        case "response.output_audio.delta":
            playRealtimeAudio(session, event);
            break;
        case "response.output_audio.done":
        case "response.done":
            session.outputActive = false;
            break;
        case "response.function_call_arguments.done":
            handleFunctionCall(session, event).catch((error) => {
                session.lastError = error.message;
                console.warn("[ari:ai] realtime tool handling failed", {
                    linkedid: session.linkedid,
                    name: event.name,
                    message: error.message,
                });
            });
            break;
        case "conversation.item.input_audio_transcription.completed":
            saveTranscript(session, "user", event.transcript, event).catch(() => {});
            break;
        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done":
            saveTranscript(session, "assistant", event.transcript, event).catch(() => {});
            break;
        case "input_audio_buffer.speech_started":
            handleInterruption(session);
            break;
        case "error":
            session.lastError = event.error?.message || JSON.stringify(event.error || event);
            console.warn("[ari:ai] realtime event error", {
                linkedid: session.linkedid,
                error: event.error || event,
            });
            break;
        default:
            break;
    }
}

function playRealtimeAudio(session, event) {
    const delta = event.delta || "";

    if (!delta) {
        return;
    }

    session.currentAssistantItemId = event.item_id || session.currentAssistantItemId;

    const pcmOutput = resamplePcm16(
        Buffer.from(delta, "base64"),
        env.trunkAiOutputSampleRate,
        ASTERISK_PCM_RATE
    );

    if (ariMediaService.sendPcm48ToAsterisk(session.linkedid, pcmOutput)) {
        session.outputFramesSent += 1;
        session.updatedAt = new Date().toISOString();
    }
}

async function handleFunctionCall(session, event) {
    const result = await callTool(
        event.name,
        toolContext(session, event.call_id),
        parseJsonObject(event.arguments)
    ).catch((error) => ({
        ok: false,
        message: error.message,
        status: error.response && error.response.status,
        data: error.response && error.response.data,
    }));

    session.toolCalls += 1;

    sendRealtimeEvent(session, {
        type: "conversation.item.create",
        item: {
            type: "function_call_output",
            call_id: event.call_id,
            output: JSON.stringify(result),
        },
    });

    sendRealtimeEvent(session, {
        type: "response.create",
        response: {
            output_modalities: ["audio"],
        },
    });
}

function handleInterruption(session) {
    if (!session.outputActive || !session.currentResponseId) {
        return;
    }

    sendRealtimeEvent(session, {
        type: "response.cancel",
    });

    if (session.currentAssistantItemId) {
        sendRealtimeEvent(session, {
            type: "conversation.item.truncate",
            item_id: session.currentAssistantItemId,
            content_index: 0,
            audio_end_ms: 0,
        });
    }

    session.outputActive = false;
}

function requestInitialGreeting(session) {
    if (!session.initialGreeting || session.initialGreetingRequested) {
        return;
    }

    session.initialGreetingRequested = true;
    session.initialGreetingPending = false;

    sendRealtimeEvent(session, {
        type: "response.create",
        response: {
            output_modalities: ["audio"],
            instructions: `Di exactamente este saludo inicial, sin agregar frases, preguntas ni informacion adicional: "${session.initialGreeting}"`,
        },
    });
}

async function saveTranscript(session, role, text, event) {
    text = normalizeText(text);

    if (!text || !session.toolsBaseUrl) {
        return;
    }

    await callTool(
        "save_call_event",
        toolContext(session, event.event_id),
        {
            role,
            text,
            event: event.type,
        }
    );

    session.transcriptsSaved += 1;
}

function sendRealtimeEvent(session, event) {
    if (!session.realtimeSocket || session.realtimeSocket.readyState !== WebSocket.OPEN) {
        return;
    }

    session.realtimeSocket.send(JSON.stringify(event));
}

function toolContext(session, toolCallId = null) {
    return {
        channel: "trunk",
        call_id: session.linkedid,
        session_id: session.id,
        tenant: session.tenant,
        agent_id: session.agentId,
        tool_call_id: toolCallId,
        tools_base_url: session.toolsBaseUrl,
    };
}

function snapshotAiSession(session) {
    return {
        id: session.id,
        linkedid: session.linkedid,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        closedAt: session.closedAt,
        closeReason: session.closeReason,
        mediaSessionId: session.mediaSessionId,
        agentId: session.agentId,
        tenant: session.tenant,
        model: session.model,
        voice: session.voice,
        language: session.language,
        realtimeReady: session.realtimeReady,
        asteriskAudioReady: session.asteriskAudioReady,
        inputFramesSent: session.inputFramesSent,
        outputFramesSent: session.outputFramesSent,
        toolCalls: session.toolCalls,
        transcriptsSaved: session.transcriptsSaved,
        initialGreetingConfigured: Boolean(session.initialGreeting),
        initialGreetingRequested: session.initialGreetingRequested,
        lastError: session.lastError,
    };
}

function getMutableSession(idOrLinkedid) {
    const key = String(idOrLinkedid || "").trim();

    return aiSessionsById.get(key) || aiSessionsByLinkedId.get(key) || null;
}

function ensureAiEnabled() {
    if (!env.trunkAiEnabled) {
        const error = new Error("TRUNK_AI_ENABLED is disabled");
        error.status = 503;
        throw error;
    }

    if (!env.openaiApiKey) {
        const error = new Error("OPENAI_API_KEY is not configured");
        error.status = 503;
        throw error;
    }
}

function defaultInstructions() {
    return "Eres un agente de voz de EVA en una llamada telefonica. Responde en espanol con frases breves y naturales.";
}

function functionTool(name, description, parameters) {
    return {
        type: "function",
        name,
        description,
        parameters,
    };
}

function normalizeText(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.replace(/\s+/g, " ").trim();
}

function parseJsonObject(value) {
    if (!value) {
        return {};
    }

    try {
        const parsed = JSON.parse(value);

        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    } catch (_) {
        return {};
    }
}

function waitForOpenSocket(socket, timeoutMs) {
    if (socket.readyState === WebSocket.OPEN) {
        return Promise.resolve(true);
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for OpenAI Realtime WebSocket"));
        }, timeoutMs);

        function cleanup() {
            clearTimeout(timeout);
            socket.off("open", onOpen);
            socket.off("error", onError);
            socket.off("close", onClose);
        }

        function onOpen() {
            cleanup();
            resolve(true);
        }

        function onError(error) {
            cleanup();
            reject(error);
        }

        function onClose(code) {
            cleanup();
            reject(new Error(`OpenAI Realtime WebSocket closed before open: ${code}`));
        }

        socket.on("open", onOpen);
        socket.on("error", onError);
        socket.on("close", onClose);
    });
}

function waitForRealtimeSessionUpdated(socket, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for OpenAI Realtime session.updated"));
        }, timeoutMs);

        function cleanup() {
            clearTimeout(timeout);
            socket.off("message", onMessage);
            socket.off("error", onError);
            socket.off("close", onClose);
        }

        function onMessage(message) {
            try {
                const event = JSON.parse(message.toString());

                if (event.type === "session.updated") {
                    cleanup();
                    resolve(event);
                }
            } catch (_) {
                // Ignore non-JSON messages until timeout.
            }
        }

        function onError(error) {
            cleanup();
            reject(error);
        }

        function onClose(code) {
            cleanup();
            reject(new Error(`OpenAI Realtime WebSocket closed before session.updated: ${code}`));
        }

        socket.on("message", onMessage);
        socket.on("error", onError);
        socket.on("close", onClose);
    });
}

module.exports = {
    startAiSessionByLinkedId,
    closeAiSession,
    getAiSession,
    listAiSessions,
};
