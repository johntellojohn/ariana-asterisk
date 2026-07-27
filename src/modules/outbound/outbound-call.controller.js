const outboundCallService = require("./outbound-call.service");

async function create(req, res, next) {
    try {
        const call = await outboundCallService.createOutboundCall(req.body || {});

        res.status(202).json({
            ok: true,
            data: call,
        });
    } catch (error) {
        next(error);
    }
}

function index(req, res) {
    const calls = outboundCallService.listOutboundCalls();

    res.json({
        ok: true,
        total: calls.length,
        data: calls,
    });
}

function show(req, res) {
    const call = outboundCallService.getOutboundCall(req.params.outboundCallId);

    if (!call) {
        return res.status(404).json({
            ok: false,
            message: "Outbound call not found",
        });
    }

    return res.json({
        ok: true,
        data: call,
    });
}

async function hangup(req, res, next) {
    try {
        const call = await outboundCallService.hangupOutboundCall(
            req.params.outboundCallId,
            req.body.reason || "outbound_cancelled"
        );

        res.json({
            ok: true,
            data: call,
        });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    create,
    index,
    show,
    hangup,
};
