const fs = require("fs");

const env = require("../../config/env");
const { getOpenAIClient } = require("../openai/openai.client");

const STT_MODELS = [
    "gpt-4o-mini-transcribe",
    "gpt-4o-transcribe",
    "gpt-4o-transcribe-diarize",
    "whisper-1",
];

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function normalizeModel(model) {
    const selectedModel = model || env.openaiSttModel;

    if (!STT_MODELS.includes(selectedModel)) {
        throw httpError(
            422,
            `Unsupported STT model. Allowed models: ${STT_MODELS.join(", ")}`
        );
    }

    return selectedModel;
}

function normalizeLanguage(language) {
    if (!language) {
        return undefined;
    }

    const normalized = String(language).trim().toLowerCase();

    if (!/^[a-z]{2}(-[a-z]{2})?$/.test(normalized)) {
        throw httpError(422, "language must be an ISO code like es or en");
    }

    return normalized;
}

async function transcribe({ file, body = {}, cleanup = false }) {
    if (!file || !file.path) {
        throw httpError(422, "audio file is required");
    }

    try {
        const model = normalizeModel(body.model);
        const client = getOpenAIClient();
        const request = {
            file: fs.createReadStream(file.path),
            model,
            response_format: "json",
        };
        const language = normalizeLanguage(body.language);
        const prompt = body.prompt ? String(body.prompt).trim() : "";

        if (language) {
            request.language = language;
        }

        if (prompt && model !== "gpt-4o-transcribe-diarize") {
            request.prompt = prompt;
        }

        const response = await client.audio.transcriptions.create(request);

        return {
            provider: "openai",
            model,
            text: response.text || "",
            usage: response.usage || null,
            audio: {
                filename: file.originalname,
                mime_type: file.mimetype,
                size_bytes: file.size,
            },
        };
    } finally {
        if (cleanup) {
            await fs.promises.unlink(file.path).catch(() => {});
        }
    }
}

module.exports = {
    transcribe,
};
