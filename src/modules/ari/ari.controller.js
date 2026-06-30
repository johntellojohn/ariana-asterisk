const ariService = require("./ari.service");
const ariMediaService = require("./ari-media.service");
const ariAiSessionService = require("./ari-ai-session.service");

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
    try {
        const session = await ariAiSessionService.startAiSessionByLinkedId(
            req.params.linkedid,
            req.body || {}
        );

        res.json({
            ok: true,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function closeCallAiSession(req, res, next) {
    try {
        const session = await ariAiSessionService.closeAiSession(
            req.params.linkedid,
            req.body.reason || "closed_by_api"
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
    closeCallAiSession,
    answerSession,
    answerCall,
    bridgeSession,
    bridgeCall,
    playMedia,
    playCallMedia,
    hangupSession,
    hangupCall,
};
