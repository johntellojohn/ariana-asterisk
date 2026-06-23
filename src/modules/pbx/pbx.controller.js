const pbxService = require("./pbx.service");

function health(req, res) {
    res.json({
        ok: true,
        data: pbxService.getStatus(),
    });
}

function callEvents(req, res) {
    const events = pbxService.getCallEvents();

    res.json({
        ok: true,
        total: events.length,
        data: events,
    });
}

function callsSummary(req, res) {
    const calls = pbxService.getCallsSummary();

    res.json({
        ok: true,
        total: calls.length,
        data: calls,
    });
}

function showCall(req, res) {
    const call = pbxService.getCallByLinkedId(req.params.linkedid);

    if (!call) {
        return res.status(404).json({
            ok: false,
            message: "PBX call not found",
        });
    }

    return res.json({
        ok: true,
        data: call,
    });
}

function callDiagnostics(req, res) {
    const diagnostics = pbxService.getCallDiagnostics(req.params.linkedid);

    if (!diagnostics) {
        return res.status(404).json({
            ok: false,
            message: "PBX call not found",
        });
    }

    return res.json({
        ok: true,
        data: diagnostics,
    });
}

async function amiStatus(req, res, next) {
    try {
        const response = await pbxService.getAmiStatus();

        res.json({
            ok: true,
            data: response,
        });
    } catch (error) {
        next(error);
    }
}

async function hangupCall(req, res, next) {
    try {
        const response = await pbxService.hangupCall(
            req.params.linkedid,
            req.body.reason
        );

        res.json({
            ok: true,
            data: response,
        });
    } catch (error) {
        next(error);
    }
}

async function connectCallToExtension(req, res, next) {
    try {
        const response = await pbxService.connectCallToExtension(
            req.params.linkedid,
            req.body.extension,
            req.body.context
        );

        res.json({
            ok: true,
            data: response,
        });
    } catch (error) {
        next(error);
    }
}

async function originateExtension(req, res, next) {
    try {
        const response = await pbxService.originateExtension(
            req.body.fromExtension,
            req.body.toExtension
        );

        res.json({
            ok: true,
            data: response,
        });
    } catch (error) {
        next(error);
    }
}

async function originateExternal(req, res, next) {
    try {
        const response = await pbxService.originateExternal(
            req.body.fromExtension,
            req.body.phoneNumber
        );

        res.json({
            ok: true,
            data: response,
        });
    } catch (error) {
        next(error);
    }
}

async function originateDirect(req, res, next) {
    try {
        const response = await pbxService.originateDirect(
            req.body.phoneNumber,
            req.body.trunkEndpoint
        );

        res.json({
            ok: true,
            data: response,
        });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    health,
    callEvents,
    callsSummary,
    showCall,
    callDiagnostics,
    amiStatus,
    hangupCall,
    connectCallToExtension,
    originateExtension,
    originateExternal,
    originateDirect,
};
