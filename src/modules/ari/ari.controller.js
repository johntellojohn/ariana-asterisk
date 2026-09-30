const ariService = require("./ari.service");
const ariMediaService = require("./ari-media.service");
const ariAiSessionService = require("./ari-ai-session.service");
const env = require("../../config/env");
const pbxService = require("../pbx/pbx.service");

function health(req, res) {
    res.json({
        ok: true,
        data: ariService.getStatus(),
    });
}

function events(req, res) {
    const items = ariService.getEvents();

    res.json({
        ok: true,
        total: items.length,
        data: items,
    });
}

function sessions(req, res) {
    const items = ariService.listSessions();

    res.json({
        ok: true,
        total: items.length,
        data: items,
    });
}

function mediaSessions(req, res) {
    const items = ariMediaService.listMediaSessions();

    res.json({
        ok: true,
        total: items.length,
        data: items,
    });
}

function aiSessions(req, res) {
    const items = ariAiSessionService.listAiSessions();

    res.json({
        ok: true,
        total: items.length,
        data: items,
    });
}

function showSession(req, res) {
    const session = ariService.getSession(req.params.channelId);

    if (!session) {
        return res.status(404).json({
            ok: false,
            message: "ARI session not found",
        });
    }

    return res.json({
        ok: true,
        data: session,
    });
}

function showCall(req, res) {
    const session = ariService.getSessionByLinkedId(req.params.linkedid);

    if (!session) {
        return res.status(404).json({
            ok: false,
            message: "ARI session not found for linkedid",
        });
    }

    return res.json({
        ok: true,
        data: session,
    });
}

async function answerSession(req, res, next) {
    try {
        const session = await ariService.answerSession(req.params.channelId);

        res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function answerCall(req, res, next) {
    try {
        const session = await ariService.answerCallByLinkedId(req.params.linkedid);

        res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function bridgeSession(req, res, next) {
    try {
        const session = await ariService.ensureBridge(req.params.channelId);

        res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function bridgeCall(req, res, next) {
    try {
        const session = await ariService.ensureCallBridgeByLinkedId(req.params.linkedid);

        res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function playMedia(req, res, next) {
    try {
        const result = await ariService.playMedia(
            req.params.channelId,
            req.body.media || req.body.sound || req.body.audio
        );

        res.json({
            ok: true,
            data: result,
        });
    } catch (error) {
        next(error);
    }
}

async function playCallMedia(req, res, next) {
    try {
        const result = await ariService.playCallMediaByLinkedId(
            req.params.linkedid,
            req.body.media || req.body.sound || req.body.audio
        );

        res.json({
            ok: true,
            data: result,
        });
    } catch (error) {
        next(error);
    }
}

async function hangupSession(req, res, next) {
    try {
        const session = await ariService.hangupSession(
            req.params.channelId,
            req.body.reason || "normal"
        );

        res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function hangupCall(req, res, next) {
    try {
        const session = await ariService.hangupCallByLinkedId(
            req.params.linkedid,
            req.body.reason || "normal"
        );

        res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function startCallMediaSession(req, res, next) {
    try {
        const session = await ariMediaService.startMediaSessionByLinkedId(
            req.params.linkedid,
            {
                owner: "agent",
                agentId: req.body.agent_id || req.body.agentId || null,
                tenant: req.body.tenant || req.body.database || null,
                callbackUrl: req.body.callback_url || req.body.callbackUrl || null,
                transcribeRecording: booleanInput(
                    req.body,
                    ["transcribe_recording", "transcribeRecording"],
                    true
                ),
            }
        );

        res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function closeCallMediaSession(req, res, next) {
    try {
        const session = await ariMediaService.closeMediaSession(
            req.params.linkedid,
            req.body.reason || "closed_by_api"
        );

        if (!session) {
            return res.status(404).json({
                ok: false,
                message: "ARI media session not found",
            });
        }

        return res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function startCallAiSession(req, res, next) {
    console.log("[ari:ai] ai-session request received", {
        linkedid: req.params.linkedid,
        agentId: req.body?.agent_id || null,
        tenant: req.body?.tenant || null,
        channel: req.body?.channel || null,
        model: req.body?.realtime?.model || null,
        voice: req.body?.realtime?.voice || null,
        language: req.body?.realtime?.language || null,
        hasInstructions: Boolean(req.body?.realtime?.instructions),
        instructionsLength: String(req.body?.realtime?.instructions || "").length,
        hasInitialGreeting: Boolean(String(req.body?.initial_greeting || "").trim()),
    });

    try {
        const session = await ariAiSessionService.startAiSessionByLinkedId(
            req.params.linkedid,
            req.body || {}
        );

        console.log("[ari:ai] ai-session request completed", {
            linkedid: req.params.linkedid,
            sessionId: session.id,
            mediaSessionId: session.mediaSessionId,
            status: session.status,
            realtimeReady: session.realtimeReady,
            asteriskAudioReady: session.asteriskAudioReady,
        });

        res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        console.warn("[ari:ai] ai-session request failed", {
            linkedid: req.params.linkedid,
            agentId: req.body?.agent_id || null,
            status: error.status || null,
            message: error.message,
        });

        next(error);
    }
}

async function activateCallAiSession(req, res, next) {
    console.log("[ari:ai] human to AI activation request received", {
        linkedid: req.params.linkedid,
        transferId: req.body?.transfer_id || null,
        agentId: req.body?.agent_id || null,
        hasHandoffContext: Boolean(String(req.body?.handoff_context || "").trim()),
    });

    try {
        const session = await ariAiSessionService.activateAiSessionByLinkedId(
            req.params.linkedid,
            req.body || {}
        );

        res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        console.warn("[ari:ai] human to AI activation failed", {
            linkedid: req.params.linkedid,
            transferId: req.body?.transfer_id || null,
            agentId: req.body?.agent_id || null,
            status: error.status || null,
            message: error.message,
        });

        next(error);
    }
}

async function closeCallAiSession(req, res, next) {
    try {
        const reason = req.body.reason || "closed_by_api";
        const humanAnswer = String(reason).match(/^human_agent_(\d+)_answering$/i);
        const session = await ariAiSessionService.closeAiSession(
            req.params.linkedid,
            reason,
            humanAnswer
                ? {
                    handoffToAgent: true,
                    agentId: Number(humanAnswer[1]),
                }
                : {}
        );

        if (!session) {
            return res.status(404).json({
                ok: false,
                message: "ARI AI session not found",
            });
        }

        return res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function startCallWaiting(req, res, next) {
    try {
        const targetLinkedid = String(req.params.linkedid || "").trim();
        let session = ariService.getSessionByLinkedId(targetLinkedid);

        if (!session && env.ariStasisRedirectEnabled && typeof pbxService.redirectCallToStasis === "function") {
            await pbxService.redirectCallToStasis(targetLinkedid).catch(() => {});
            for (let i = 0; i < 20; i++) {
                session = ariService.getSessionByLinkedId(targetLinkedid);
                if (session) break;
                await new Promise((r) => setTimeout(r, 50));
            }
        }

        if (!session) {
            return res.status(404).json({
                ok: false,
                message: "ARI session not found for linkedid",
            });
        }

        if (!session.answeredAt && !["answered", "bridged"].includes(session.status)) {
            await ariService.answerCallByLinkedId(targetLinkedid);
        }

        const mohClass = req.body.moh_class || req.body.mohClass || "default";
        await ariService.startMoh(session.channelId, mohClass);

        res.json({
            ok: true,
            data: {
                linkedid: targetLinkedid,
                channelId: session.channelId,
                status: "waiting",
                mohClass,
            },
        });
    } catch (error) {
        next(error);
    }
}

async function stopCallWaiting(req, res, next) {
    try {
        const targetLinkedid = String(req.params.linkedid || "").trim();
        await ariService.stopMoh(targetLinkedid);

        res.json({
            ok: true,
            data: {
                linkedid: targetLinkedid,
                status: "waiting_stopped",
            },
        });
    } catch (error) {
        next(error);
    }
}

function booleanInput(payload, keys, fallback = false) {
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(payload || {}, key)) {
            continue;
        }

        const value = payload[key];

        if (typeof value === "boolean") {
            return value;
        }

        if (typeof value === "number") {
            return value !== 0;
        }

        const normalized = String(value || "").trim().toLowerCase();

        if (["1", "true", "yes", "on"].includes(normalized)) {
            return true;
        }

        if (["0", "false", "no", "off", ""].includes(normalized)) {
            return false;
        }
    }

    return fallback;
}

module.exports = {
    health,
    events,
    sessions,
    mediaSessions,
    aiSessions,
    showSession,
    showCall,
    startCallMediaSession,
    closeCallMediaSession,
    startCallAiSession,
    activateCallAiSession,
    closeCallAiSession,
    answerSession,
    answerCall,
    bridgeSession,
    bridgeCall,
    playMedia,
    playCallMedia,
    hangupSession,
    hangupCall,
    startCallWaiting,
    stopCallWaiting,
};
