const OpenAI = require("openai");
const env = require("../../config/env");

let client;

function getOpenAIClient() {
    if (!env.openaiApiKey) {
        const error = new Error("OPENAI_API_KEY is not configured");
        error.status = 503;
        throw error;
    }

    if (!client) {
        client = new OpenAI({
            apiKey: env.openaiApiKey,
        });
    }

    return client;
}

module.exports = {
    getOpenAIClient,
};
