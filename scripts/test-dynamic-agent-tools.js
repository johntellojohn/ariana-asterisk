const assert = require("assert");
const axios = require("axios");

const ariAiSessionService = require("../src/modules/ari/ari-ai-session.service");
const { callTool } = require("../src/modules/laravel/voice-agent-tools.service");

function findTool(tools, name) {
    return tools.find((tool) => tool.name === name);
}

function testDynamicToolsAreMergedWithoutReplacingBaseTools() {
    const session = ariAiSessionService.__test.createAiSession("linked-dynamic-tools", {
        dynamic_tools: [
            {
                type: "function",
                function: {
                    name: "consultar_cliente",
                    description: "Busca otro cliente existente en EVA.",
                    parameters: {
                        type: "object",
                        properties: {
                            criterio: { type: "string" },
                        },
                        required: ["criterio"],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "search_customer",
                    description: "No debe reemplazar la tool fija.",
                    parameters: {
                        type: "object",
                        properties: {
                            criterio: { type: "string" },
                        },
                    },
                },
            },
        ],
    });

    const configuredTools = ariAiSessionService.__test.tools(session);
    const searchCustomer = findTool(configuredTools, "search_customer");
    const consultarCliente = findTool(configuredTools, "consultar_cliente");
    const searchCustomerCount = configuredTools
        .filter((tool) => tool.name === "search_customer")
        .length;

    assert(searchCustomer, "search_customer base tool not found");
    assert(consultarCliente, "consultar_cliente dynamic tool not found");
    assert.strictEqual(searchCustomerCount, 1, "dynamic tools must not duplicate base names");
    assert.match(searchCustomer.description, /asociado a la llamada/i);
    assert.strictEqual(consultarCliente.parameters.required[0], "criterio");
    assert.match(
        ariAiSessionService.__test.dynamicToolsInstructions(session),
        /consultar_cliente/
    );
}

function testRealtimeSpeedIsAppliedToAudioOutput() {
    const session = ariAiSessionService.__test.createAiSession("linked-realtime-speed", {
        realtime: {
            speed: 1.35,
        },
    });

    const config = ariAiSessionService.__test.sessionConfig(session);

    assert.strictEqual(session.speed, 1.35);
    assert.strictEqual(config.audio.output.speed, 1.35);
}

function testRealtimeSpeedIsClampedToRealtimeLimit() {
    const session = ariAiSessionService.__test.createAiSession("linked-realtime-speed-clamped", {
        realtime: {
            speed: 3.25,
        },
    });

    const config = ariAiSessionService.__test.sessionConfig(session);

    assert.strictEqual(session.speed, 1.5);
    assert.strictEqual(config.audio.output.speed, 1.5);
}

async function testUnknownToolRunsThroughGenericEndpoint() {
    const originalPost = axios.post;
    let request = null;

    axios.post = async (url, body, options) => {
        request = { url, body, options };

        return { data: { ok: true } };
    };

    try {
        await callTool(
            "consultar_cliente",
            {
                channel: "trunk",
                call_id: "linked-dynamic-tools",
                session_id: "session-dynamic-tools",
                agent_id: 44,
                tool_call_id: "tool-call-dynamic",
                tools_base_url: "https://eva.test/api/voice-agent/tools/",
            },
            { criterio: "593996513419" }
        );
    } finally {
        axios.post = originalPost;
    }

    assert(request, "axios.post was not called");
    assert.strictEqual(request.url, "https://eva.test/api/voice-agent/tools/run");
    assert.strictEqual(request.body.tool_name, "consultar_cliente");
    assert.strictEqual(request.body.channel, "trunk");
    assert.strictEqual(request.body.call_id, "linked-dynamic-tools");
    assert.strictEqual(request.body.arguments.criterio, "593996513419");
}

async function main() {
    testDynamicToolsAreMergedWithoutReplacingBaseTools();
    testRealtimeSpeedIsAppliedToAudioOutput();
    testRealtimeSpeedIsClampedToRealtimeLimit();
    await testUnknownToolRunsThroughGenericEndpoint();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
