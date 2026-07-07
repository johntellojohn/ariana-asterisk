const env = require("../../config/env");
const { getOpenAIClient } = require("../openai/openai.client");

async function analyzeRecording(recording = {}) {
    const transcript = String(recording.transcript || "").trim();
    const segments = Array.isArray(recording.transcriptSegments)
        ? recording.transcriptSegments
        : [];
    const fallback = fallbackAnalysis(recording, segments, transcript);

    if (!env.callRecordingAnalyze || !transcript) {
        return fallback;
    }

    try {
        const client = getOpenAIClient();
        const response = await client.chat.completions.create({
            model: env.openaiAnalysisModel,
            temperature: 0.2,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: [
                        "Analiza llamadas telefonicas de atencion al cliente.",
                        "Devuelve solo JSON valido con: summary, motive, sentiment, risk, score, qualification, next_step, confidence, metrics.",
                        "score debe ser 0-100. risk debe ser Bajo, Medio o Alto.",
                        "metrics debe contener objetos con label, value, hint.",
                    ].join(" "),
                },
                {
                    role: "user",
                    content: JSON.stringify({
                        duration_seconds: recording.durationSeconds || 0,
                        transcript,
                        segments: segments.slice(0, 80).map((segment) => ({
                            speaker: segment.speaker,
                            side: segment.side,
                            text: segment.text,
                            start_ms: segment.start_ms,
                            end_ms: segment.end_ms,
                        })),
                    }),
                },
            ],
        });
        const raw = response.choices?.[0]?.message?.content || "";
        const parsed = JSON.parse(raw);

        return normalizeAnalysis(parsed, fallback);
    } catch (error) {
        return {
            ...fallback,
            provider_error: error.message,
        };
    }
}

function fallbackAnalysis(recording = {}, segments = [], transcript = "") {
    const durationSeconds = Number(recording.durationSeconds || 0);
    const customerTurns = segments.filter((segment) => segment.side === "customer").length;
    const agentTurns = segments.filter((segment) => segment.side === "agent").length;
    const resolved = /\b(gracias|listo|perfecto|confirmad[oa]|resuelt[oa]|ayuda)\b/i.test(transcript);
    const risk = /\b(molest|queja|reclamo|cancel|problema|no sirve|mal servicio|demora)\b/i.test(transcript)
        ? "Alto"
        : customerTurns > 0 && agentTurns === 0
            ? "Medio"
            : "Bajo";
    const score = clampScore(
        72
        + (resolved ? 12 : 0)
        - (risk === "Alto" ? 18 : risk === "Medio" ? 8 : 0)
        + (durationSeconds > 0 ? 4 : 0)
    );
    const sentiment = risk === "Alto" ? "Tenso" : resolved ? "Positivo" : "Neutral";

    return {
        summary: transcript
            ? limitText(transcript.replace(/\s+/g, " "), 240)
            : "No hubo transcripcion suficiente para generar un resumen.",
        motive: inferMotive(transcript),
        sentiment,
        risk,
        score,
        qualification: qualificationFromScore(score),
        next_step: risk === "Alto"
            ? "Revisar la llamada y dar seguimiento con prioridad."
            : "Registrar el resultado y continuar el seguimiento normal.",
        confidence: transcript ? 72 : 35,
        metrics: [
            {
                label: "Calificacion",
                value: `${score}/100`,
                hint: qualificationFromScore(score),
            },
            {
                label: "Sentimiento",
                value: sentiment,
                hint: risk === "Alto" ? "Requiere revision" : "Sin alerta fuerte",
            },
            {
                label: "Turnos",
                value: String(customerTurns + agentTurns),
                hint: `${customerTurns} cliente / ${agentTurns} agente`,
            },
            {
                label: "Riesgo",
                value: risk,
                hint: transcript ? "Derivado de la transcripcion" : "Sin audio util",
            },
        ],
        source: "fallback",
    };
}

function normalizeAnalysis(value, fallback) {
    const analysis = value && typeof value === "object" ? value : {};
    const score = clampScore(analysis.score ?? fallback.score);
    const confidence = clampScore(analysis.confidence ?? fallback.confidence);
    const metrics = Array.isArray(analysis.metrics) && analysis.metrics.length > 0
        ? analysis.metrics
        : fallback.metrics;

    return {
        summary: cleanText(analysis.summary) || fallback.summary,
        motive: cleanText(analysis.motive) || fallback.motive,
        sentiment: cleanText(analysis.sentiment) || fallback.sentiment,
        risk: normalizeRisk(analysis.risk) || fallback.risk,
        score,
        qualification: cleanText(analysis.qualification) || qualificationFromScore(score),
        next_step: cleanText(analysis.next_step) || fallback.next_step,
        confidence,
        metrics: metrics.map((metric) => ({
            label: cleanText(metric.label) || "Metrica",
            value: cleanText(metric.value) || "",
            hint: cleanText(metric.hint) || "",
        })),
        source: "openai",
        model: env.openaiAnalysisModel,
    };
}

function inferMotive(transcript) {
    const text = String(transcript || "").toLowerCase();

    if (text.includes("cita") || text.includes("agenda")) {
        return "Agenda o reserva";
    }

    if (text.includes("precio") || text.includes("costo") || text.includes("valor")) {
        return "Consulta comercial";
    }

    if (text.includes("soporte") || text.includes("problema") || text.includes("ayuda")) {
        return "Soporte";
    }

    return transcript ? "Conversacion general" : "Sin motivo detectado";
}

function normalizeRisk(value) {
    const risk = cleanText(value).toLowerCase();

    if (["alto", "media", "medio", "bajo"].includes(risk)) {
        return risk === "media" ? "Medio" : risk.charAt(0).toUpperCase() + risk.slice(1);
    }

    return "";
}

function qualificationFromScore(score) {
    if (score >= 85) {
        return "Excelente";
    }

    if (score >= 70) {
        return "Buena";
    }

    if (score >= 50) {
        return "Regular";
    }

    return "Critica";
}

function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function limitText(value, maxLength) {
    const text = cleanText(value);

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function clampScore(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return Math.max(0, Math.min(100, Math.round(number)));
}

module.exports = {
    analyzeRecording,
};
