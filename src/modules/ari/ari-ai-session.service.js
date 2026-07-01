const crypto = require("crypto");
const WebSocket = require("ws");

const env = require("../../config/env");
const ariMediaService = require("./ari-media.service");
const { resamplePcm16 } = require("./pcm-utils");
const { SpeechInterruptionGate } = require("./speech-interruption-gate");
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

    const session = {
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
        lastOutputAudioAt: 0,
        inputSpeechFrames: [],
        lastInputLevel: 0,
        interruptionInputChunks: [],
        interruptionSpeechActive: false,
        interruptionStartedAt: null,
        interruptionsConfirmed: 0,
        interruptionsIgnored: 0,
        toolCalls: 0,
        transcriptsSaved: 0,
        lastError: null,
    };

    session.interruptionGate = new SpeechInterruptionGate({
        debounceMs: Math.max(0, env.trunkAiInterruptionDebounceMs),
        onInterrupt: (reason) => handleInterruption(session, reason),
        onIgnored: (reason) => {
            session.interruptionsIgnored += 1;
            console.log("[ari:ai] ai interruption ignored", {
                linkedid: session.linkedid,
                reason,
                speechMs: Math.round(confirmedSpeechMs(session)),
                minSpeechMs: env.trunkAiInterruptionMinSpeechMs,
                lastLevel: Number(session.lastInputLevel.toFixed(5)),
                rmsThreshold: env.trunkAiInterruptionRmsThreshold,
            });
        },
        shouldInterrupt: () => hasConfirmedInputSpeech(session),
    });

    return session;
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
    const speechFrame = trackInputSpeech(session, pcm48);

    if (session.initialGreetingPending && !session.initialGreetingRequested) {
        requestInitialGreeting(session);
        return;
    }

    if (isAiOutputActive(session)) {
        bufferInterruptionAudio(session, pcm48);
        evaluateInterruptionCandidate(session, speechFrame);
        return;
    }

    session.interruptionGate.cancelPending();
    session.interruptionSpeechActive = false;
    session.interruptionStartedAt = null;
    session.interruptionInputChunks = [];

    appendInputAudioToRealtime(session, pcm48);
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
            if (isAiOutputActive(session)) {
                session.interruptionGate.speechStarted("openai_speech_started");
            }
            break;
        case "input_audio_buffer.speech_stopped":
            session.interruptionGate.speechStopped("openai_speech_stopped");
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
    session.lastOutputAudioAt = Date.now();

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

function isAiOutputActive(session) {
    if (session.outputActive) {
        return true;
    }

    const mediaSession = ariMediaService.getMediaSession(session.mediaSessionId || session.linkedid);

    if (mediaSession && mediaSession.rtpSendQueueLength > 0) {
        return true;
    }

    const debounceMs = Math.max(0, env.trunkAiInterruptionDebounceMs);

    return session.lastOutputAudioAt > 0
        && Date.now() - session.lastOutputAudioAt < debounceMs;
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

function handleInterruption(session, reason = "caller_interrupted") {
    const mediaSession = ariMediaService.getMediaSession(session.mediaSessionId || session.linkedid);
    const hasQueuedAudio = Boolean(mediaSession && mediaSession.rtpSendQueueLength > 0);
    const hasActiveResponse = Boolean(session.outputActive && session.currentResponseId);

    if (!hasActiveResponse && !hasQueuedAudio) {
        return;
    }

    const clearedFrames = ariMediaService.clearAsteriskAudioQueue(session.linkedid, reason);

    if (hasActiveResponse) {
        sendRealtimeEvent(session, {
            type: "response.cancel",
        });
    }

    if (hasActiveResponse && session.currentAssistantItemId) {
        sendRealtimeEvent(session, {
            type: "conversation.item.truncate",
            item_id: session.currentAssistantItemId,
            content_index: 0,
            audio_end_ms: 0,
        });
    }

    session.outputActive = false;
    session.interruptionGate.cancelPending();
    session.interruptionSpeechActive = false;
    session.interruptionsConfirmed += 1;

    const forwardedFrames = flushBufferedInterruptionAudio(session);
    session.interruptionStartedAt = null;

    console.log("[ari:ai] ai interruption confirmed", {
        linkedid: session.linkedid,
        reason,
        responseId: session.currentResponseId,
        assistantItemId: session.currentAssistantItemId,
        clearedFrames,
        forwardedFrames,
    });
}

function appendInputAudioToRealtime(session, pcm48) {
    const pcmInput = resamplePcm16(
        pcm48,
        ASTERISK_PCM_RATE,
        env.trunkAiInputSampleRate
    );

    if (!pcmInput.length) {
        return false;
    }

    sendRealtimeEvent(session, {
        type: "input_audio_buffer.append",
        audio: pcmInput.toString("base64"),
    });

    session.inputFramesSent += 1;
    session.updatedAt = new Date().toISOString();

    return true;
}

function trackInputSpeech(session, pcm48) {
    const now = Date.now();
    const durationMs = (pcm48.length / 2 / ASTERISK_PCM_RATE) * 1000;
    const level = calculatePcm16Rms(pcm48);
    const hasSpeech = level >= env.trunkAiInterruptionRmsThreshold;
    const frame = {
        at: now,
        durationMs,
        hasSpeech,
    };

    session.lastInputLevel = level;
    session.inputSpeechFrames.push(frame);
    pruneInputSpeechFrames(session, now);

    return frame;
}

function pruneInputSpeechFrames(session, now = Date.now()) {
    const windowMs = Math.max(1, env.trunkAiInterruptionWindowMs);
    session.inputSpeechFrames = session.inputSpeechFrames.filter(
        (frame) => frame.at >= now - windowMs
    );
}

function confirmedSpeechMs(session) {
    const now = Date.now();
    pruneInputSpeechFrames(session, now);

    return session.inputSpeechFrames
        .filter((frame) => frame.hasSpeech)
        .reduce((total, frame) => total + frame.durationMs, 0);
}

function hasConfirmedInputSpeech(session) {
    return confirmedSpeechMs(session) >= env.trunkAiInterruptionMinSpeechMs;
}

function evaluateInterruptionCandidate(session, speechFrame) {
    if (speechFrame.hasSpeech) {
        if (!session.interruptionSpeechActive) {
            session.interruptionSpeechActive = true;
            session.interruptionStartedAt = speechFrame.at;

            console.log("[ari:ai] ai interruption candidate", {
                linkedid: session.linkedid,
                level: Number(session.lastInputLevel.toFixed(5)),
                rmsThreshold: env.trunkAiInterruptionRmsThreshold,
                debounceMs: env.trunkAiInterruptionDebounceMs,
            });

            session.interruptionGate.speechStarted("caller_speech_over_ai");
        }

        return;
    }

    if (
        session.interruptionSpeechActive &&
        !hasRecentInputSpeech(session, Math.max(env.ariExternalMediaFrameMs * 3, 80))
    ) {
        session.interruptionSpeechActive = false;
        session.interruptionStartedAt = null;
        session.interruptionGate.speechStopped("speech_stopped_before_debounce");
    }
}

function hasRecentInputSpeech(session, lookbackMs) {
    const now = Date.now();

    return session.inputSpeechFrames.some(
        (frame) => frame.hasSpeech && frame.at >= now - lookbackMs
    );
}

function bufferInterruptionAudio(session, pcm48) {
    const now = Date.now();
    const maxBufferMs = Math.max(
        env.trunkAiInterruptionWindowMs + 300,
        env.trunkAiInterruptionMinSpeechMs + env.trunkAiInterruptionDebounceMs + 300
    );

    session.interruptionInputChunks.push({
        at: now,
        pcm48: Buffer.from(pcm48),
    });

    session.interruptionInputChunks = session.interruptionInputChunks.filter(
        (chunk) => chunk.at >= now - maxBufferMs
    );
}

function flushBufferedInterruptionAudio(session) {
    const startedAt = session.interruptionStartedAt || Date.now();
    const includeAfter = startedAt - 300;
    const chunks = session.interruptionInputChunks.filter(
        (chunk) => chunk.at >= includeAfter
    );

    session.interruptionInputChunks = [];

    let forwardedFrames = 0;

    chunks.forEach((chunk) => {
        if (appendInputAudioToRealtime(session, chunk.pcm48)) {
            forwardedFrames += 1;
        }
    });

    return forwardedFrames;
}

function calculatePcm16Rms(buffer) {
    const samples = Math.floor(buffer.length / 2);

    if (samples <= 0) {
        return 0;
    }

    let sumSquares = 0;

    for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
        const sample = buffer.readInt16LE(offset) / 32768;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
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
        interruptionsConfirmed: session.interruptionsConfirmed,
        interruptionsIgnored: session.interruptionsIgnored,
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
