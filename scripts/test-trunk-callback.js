const laravelService = require("../src/modules/laravel/laravel.service");

async function main() {
    const linkedid = `pbx-test-${Date.now()}`;
    const now = new Date().toISOString();
    const destination = process.env.PBX_TEST_DESTINATION || "TRUNCAL-TEST";

    const payload = {
        source: "ariana-asterisk-pbx-test",
        tenant: process.env.LARAVEL_TENANT_DATABASE || process.env.LARAVEL_DATABASE || process.env.TENANT_DATABASE || undefined,
        database: process.env.LARAVEL_TENANT_DATABASE || process.env.LARAVEL_DATABASE || process.env.TENANT_DATABASE || undefined,
        event: {
            time: now,
            event: "dialbegin",
            caller: process.env.PBX_TEST_CALLER || "0999999999",
            callerName: "Prueba Troncal",
            channel: process.env.PBX_TEST_CHANNEL || "PJSIP/0999999999@fxo",
            destination,
            destChannel: process.env.PBX_TEST_DEST_CHANNEL || "PJSIP/101",
            uniqueid: `${linkedid}-unique`,
            linkedid,
        },
        summary: {
            linkedid,
            firstEventTime: now,
            lastEventTime: now,
            from: process.env.PBX_TEST_CALLER || "0999999999",
            to: destination,
            callerName: "Prueba Troncal",
            status: "IN_PROGRESS",
            answered: false,
            bridged: false,
            result: "in_progress",
            channels: [
                process.env.PBX_TEST_CHANNEL || "PJSIP/0999999999@fxo",
                process.env.PBX_TEST_DEST_CHANNEL || "PJSIP/101",
            ],
            totalEvents: 1,
        },
    };

    const response = await laravelService.sendTrunkCallEvent(payload);

    console.log(JSON.stringify({
        sent: payload,
        response,
    }, null, 2));
}

main().catch((error) => {
    console.error("Laravel trunk callback test failed", {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
    });
    process.exitCode = 1;
});
