const axios = require("axios");

const env = require("../../config/env");

const TOOL_ENDPOINTS = {
    get_agent_context: "get-agent-context",
    search_knowledge: "search-knowledge",
    search_customer: "search-customer",
    check_availability: "check-availability",
    create_appointment: "create-appointment",
    list_appointments: "list-appointments",
    show_appointments: "show-appointments",
    mostrar_agendamientos: "mostrar-agendamientos",
    reschedule_appointment: "reschedule-appointment",
    cancel_appointment: "cancel-appointment",
    save_call_event: "save-call-event",
    transfer_to_human: "transfer-to-human",
};

async function callTool(toolName, context = {}, args = {}, options = {}) {
    const toolsBaseUrl = String(
        options.toolsBaseUrl || context.tools_base_url || context.toolsBaseUrl || ""
    ).replace(/\/$/, "");

    if (!toolsBaseUrl) {
        const error = new Error("tools_base_url is required for voice agent tools");
        error.status = 422;
        throw error;
    }

    const endpoint = TOOL_ENDPOINTS[toolName] || kebabCase(toolName);
    const response = await axios.post(
        `${toolsBaseUrl}/${endpoint}`,
        {
            channel: context.channel || "trunk",
            call_id: context.call_id || context.callId || null,
            session_id: context.session_id || context.sessionId || null,
            tenant: context.tenant || null,
            agent_id: context.agent_id || context.agentId || null,
            tool_call_id: context.tool_call_id || context.toolCallId || null,
            arguments: args || {},
        },
        {
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: env.laravelVoiceToolsToken
                    ? `Bearer ${env.laravelVoiceToolsToken}`
                    : undefined,
            },
            timeout: options.timeout || env.trunkAiRealtimeToolTimeoutMs,
        }
    );

    return response.data;
}

function kebabCase(value) {
    return String(value || "")
        .trim()
        .replace(/_/g, "-")
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase();
}

module.exports = {
    callTool,
};
