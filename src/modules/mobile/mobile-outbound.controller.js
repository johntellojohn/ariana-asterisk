const mobileOutboundService = require("./mobile-outbound.service");
const mobileMediaService = require("./mobile-media.service");
const pbxService = require("../pbx/pbx.service");
const ami = require("./mobile-ami.service");

function getPbxCall(linkedid) {
    if (typeof pbxService.getCall === "function") {
        return pbxService.getCall(linkedid);
    }
    if (typeof pbxService.getCallByLinkedId === "function") {
        return pbxService.getCallByLinkedId(linkedid);
    }
    return null;
}

function primaryCallChannel(call) {
    if (typeof pbxService.primaryCallChannel === "function") {
        return pbxService.primaryCallChannel(call);
    }
    if (!call) return null;
    const external = (call.channels || []).find(
        (ch) => ch && !ch.startsWith("Local/") && !ch.startsWith("UnicastRTP/")
    );
    if (external) return external;
    const nonInternal = (call.channels || []).find(
        (ch) => ch && !ch.includes("/n") && !ch.startsWith("UnicastRTP/")
    );
    if (nonInternal) return nonInternal;
    return (call.channels || [])[0] || null;
}

async function create(req, res, next) {
    try {
        const call = await mobileOutboundService.createMobileCall(req.body || {});
        res.status(201).json({
            ok: true,
            outbound_call_id: call.outbound_call_id,
            linkedid: call.linkedid,
            ws_url: call.ws_url,
            data: call,
        });
    } catch (error) {
        next(error);
    }
}

function index(req, res, next) {
    try {
        const calls = mobileOutboundService.listCalls();
        res.json({
            ok: true,
            total: calls.length,
            data: calls,
        });
    } catch (error) {
        next(error);
    }
}

async function show(req, res, next) {
    try {
        const call = await mobileOutboundService.getCall(req.params.outboundCallId);
        if (!call) {
            return res.status(404).json({ ok: false, message: "Call not found" });
        }
        return res.json({ ok: true, data: call });
    } catch (error) {
        return next(error);
    }
}

async function showByLinkedId(req, res, next) {
    try {
        const call = await mobileOutboundService.getCallByLinkedId(req.params.linkedid);
        const mediaSession = mobileMediaService.getMediaSession(req.params.linkedid);
        if (!call && !mediaSession) {
            return res.status(404).json({ ok: false, message: "Call not found" });
        }
        return res.json({
            ok: true,
            data: {
                call: call || null,
                media_session: mediaSession || null,
            },
        });
    } catch (error) {
        return next(error);
    }
}

async function startMediaSession(req, res, next) {
    try {
        const session = await mobileMediaService.startMediaSessionByLinkedId(req.params.linkedid, {
            agentId: req.body?.agent_id || req.body?.agentId || null,
            tenant: req.body?.tenant || req.body?.database || null,
            outboundCallId: req.body?.outbound_call_id || req.body?.outboundCallId || null,
            direction: req.body?.direction || "OUTBOUND",
            extension: req.body?.extension || req.body?.agent_extension || null,
        });
        res.json({
            ok: true,
            ws_url: session.agentWebSocketUrl,
            linkedid: session.linkedid,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function closeMediaSession(req, res, next) {
    try {
        const session = await mobileMediaService.closeMediaSession(
            req.params.linkedid,
            req.body?.reason || "closed_by_mobile_api"
        );
        if (!session) {
            return res.status(404).json({ ok: false, message: "Mobile media session not found" });
        }
        return res.json({ ok: true, data: session });
    } catch (error) {
        return next(error);
    }
}

async function hangup(req, res, next) {
    try {
        const result = await mobileOutboundService.hangup(req.params.outboundCallId, req.body?.reason);
        res.json({ ok: true, data: result });
    } catch (error) {
        next(error);
    }
}

// POST /api/mobile/calls/:linkedid/answer
async function answer(req, res) {
    try {
        const linkedid = req.params.linkedid;

        // 1. Priorizar el canal primario enviado por EVA en req.body.channel (ej: PJSIP/fxo-0000000d)
        let channelToRedirect = req.body?.channel;

        // 2. Si no viene en el body, buscar el canal raíz en el tracking del gateway
        if (!channelToRedirect) {
            const call = getPbxCall(linkedid);
            channelToRedirect = call ? primaryCallChannel(call) : null;
        }

        // Regla de oro: NUNCA redirigir canales 'Local/...' ya destruidos
        if (channelToRedirect && channelToRedirect.startsWith("Local/")) {
            const call = getPbxCall(linkedid);
            const rootChannel = call?.channels?.find((c) => !c.startsWith("Local/"));
            if (rootChannel) {
                channelToRedirect = rootChannel;
            }
        }

        if (!channelToRedirect) {
            return res.status(400).json({
                ok: false,
                error: "Falta el canal primario en req.body.channel",
            });
        }

        console.log(`[MOBILE ANSWER] Redirigiendo canal ${channelToRedirect} a Stasis [ariana-ari]...`);

        // 3. Ejecutar AMI Redirect hacia el contexto [ariana-ari]
        await ami.action({
            Action: "Redirect",
            Channel: channelToRedirect,
            Context: "ariana-ari",
            Exten: "s",
            Priority: 1,
        });

        // 4. Iniciar sesión de medios WebRTC/WebSocket para el móvil
        const mediaSession = await mobileMediaService.startMediaSessionByLinkedId(linkedid, {
            agentId: req.body?.agent_id || req.body?.agentId,
            extension: req.body?.extension || req.body?.agent_extension,
        });

        return res.json({
            ok: true,
            ws_url: mediaSession.agentWebSocketUrl,
            data: {
                linkedid,
                ws_url: mediaSession.agentWebSocketUrl,
            },
        });
    } catch (error) {
        console.error("[MOBILE ANSWER ERROR]:", error);
        return res.status(500).json({ ok: false, error: error.message });
    }
}

// POST /api/mobile/calls/:linkedid/hangup
async function hangupCall(req, res) {
    try {
        const linkedid = req.params.linkedid;
        let channelToHangup = req.body?.channel;

        if (!channelToHangup) {
            const call = getPbxCall(linkedid);
            channelToHangup = call ? primaryCallChannel(call) : null;
        }

        if (channelToHangup) {
            console.log(`[MOBILE HANGUP] Colgando canal físico ${channelToHangup} vía AMI...`);
            await ami
                .action({
                    Action: "Hangup",
                    Channel: channelToHangup,
                    Cause: 16, // Normal Clearing
                })
                .catch((err) => console.warn("[MOBILE HANGUP WARN]:", err.message));
        }

        // Detener la sesión de audio móvil si existía
        if (mobileMediaService.hasSession(linkedid)) {
            await mobileMediaService.stopMediaSessionByLinkedId(linkedid);
        }

        return res.json({ ok: true, message: "Llamada móvil finalizada correctamente." });
    } catch (error) {
        console.error("[MOBILE HANGUP ERROR]:", error);
        return res.status(500).json({ ok: false, error: error.message });
    }
}

module.exports = {
    create,
    index,
    show,
    showByLinkedId,
    startMediaSession,
    closeMediaSession,
    hangup,
    answer,
    hangupCall,
};
