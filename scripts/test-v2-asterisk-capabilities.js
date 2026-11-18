const assert = require("assert");
const EventEmitter = require("events");
const {
    parseAsteriskVersion,
    supportsExternalMediaVersion,
    normalizeAnswerMode,
    buildCapabilitiesSnapshot,
    resolveGatewayCapabilities,
} = require("../src/modules/pbx/asterisk-capabilities");
const pbxService = require("../src/modules/pbx/pbx.service");
const { QueuePresenceService } = require("../src/modules/pbx/queue-presence.service");

async function run() {
    // 1. Version parsing across Issabel / Asterisk formats
    const v13 = parseAsteriskVersion("13.30.0");
    assert.strictEqual(v13.detected, true);
    assert.strictEqual(v13.major, 13);
    assert.strictEqual(v13.minor, 30);
    assert.strictEqual(supportsExternalMediaVersion(v13), false);

    const v13Full = parseAsteriskVersion("Asterisk 13.22.0 built by mockbuild on centos7");
    assert.strictEqual(v13Full.parsedVersion, "13.22.0");
    assert.strictEqual(supportsExternalMediaVersion(v13Full), false);

    const v165 = parseAsteriskVersion("16.5.1");
    assert.strictEqual(supportsExternalMediaVersion(v165), false);

    const v166 = parseAsteriskVersion("16.6.0");
    assert.strictEqual(supportsExternalMediaVersion(v166), true);

    const v20 = parseAsteriskVersion("Asterisk 20.9.3");
    assert.strictEqual(v20.major, 20);
    assert.strictEqual(supportsExternalMediaVersion(v20), true);

    const vCert = parseAsteriskVersion("certified/13.21-cert6");
    assert.strictEqual(vCert.major, 13);
    assert.strictEqual(supportsExternalMediaVersion(vCert), false);

    assert.strictEqual(supportsExternalMediaVersion(null), null);

    // 2. Mode resolution & compatibility warnings
    assert.strictEqual(normalizeAnswerMode("browser"), "ari_media");
    assert.strictEqual(normalizeAnswerMode("EXTENSION"), "extension");
    assert.strictEqual(normalizeAnswerMode("unknown", "auto"), "auto");

    const autoHospital = buildCapabilitiesSnapshot({
        rawVersion: "13.30.0",
        versionSource: "ari",
        configuredAnswerMode: "auto",
        sipBridgeAvailable: false,
    });
    assert.strictEqual(autoHospital.supportsExternalMedia, false);
    assert.strictEqual(autoHospital.recommendedAnswerMode, "extension");
    assert.strictEqual(autoHospital.effectiveAnswerMode, "extension");
    assert.strictEqual(autoHospital.compatibleWithConfiguredMode, true);

    const forcedAriOn13 = buildCapabilitiesSnapshot({
        rawVersion: "13.30.0",
        versionSource: "ari",
        configuredAnswerMode: "ari_media",
    });
    assert.strictEqual(forcedAriOn13.effectiveAnswerMode, "ari_media");
    assert.strictEqual(forcedAriOn13.compatibleWithConfiguredMode, false);
    assert.ok(forcedAriOn13.compatibilityWarning && forcedAriOn13.compatibilityWarning.includes("13.30.0"));

    const bridgeAuto13 = buildCapabilitiesSnapshot({
        rawVersion: "13.22.0",
        versionSource: "ami",
        configuredAnswerMode: "auto",
        sipBridgeAvailable: true,
    });
    assert.strictEqual(bridgeAuto13.recommendedAnswerMode, "sip_bridge");
    assert.strictEqual(bridgeAuto13.effectiveAnswerMode, "sip_bridge");

    const gateway20 = resolveGatewayCapabilities({
        ariStatus: { asteriskVersion: "20.9.3", asteriskRawVersion: "20.9.3" },
        pbxStatus: { asteriskVersion: "13.30.0" },
        configuredAnswerMode: "auto",
    });
    assert.strictEqual(gateway20.versionSource, "ari");
    assert.strictEqual(gateway20.effectiveAnswerMode, "ari_media");
    assert.strictEqual(gateway20.supportsExternalMedia, true);

    // 3. Multi-event AMI QueueStatus collection & compatibility with QueuePresenceService
    const fakeAmi = new EventEmitter();
    fakeAmi.action = (action, cb) => {
        const actionid = action.ActionID;
        process.nextTick(() => {
            cb(null, { response: "Success", actionid, message: "Queue status will follow" });
            fakeAmi.emit("managerevent", {
                event: "QueueParams",
                actionid,
                queue: "650",
                calls: "2",
                holdtime: "14",
                strategy: "rrmemory",
            });
            fakeAmi.emit("managerevent", {
                event: "QueueMember",
                actionid,
                queue: "650",
                name: "SIP/101",
                location: "SIP/101",
                stateinterface: "SIP/101",
                membership: "static",
                paused: "0",
                status: "1",
                incall: "0",
                callstaken: "5",
            });
            fakeAmi.emit("managerevent", {
                event: "QueueMember",
                actionid,
                queue: "650",
                name: "SIP/150",
                location: "SIP/150",
                membership: "static",
                paused: "1",
                pausedreason: "offline_eva",
                status: "5",
                incall: "0",
            });
            fakeAmi.emit("managerevent", {
                event: "QueueEntry",
                actionid,
                queue: "650",
                position: "1",
                channel: "SIP/telco-0001",
                calleridnum: "099111222",
                wait: "9",
            });
            fakeAmi.emit("managerevent", {
                event: "QueueEntry",
                actionid,
                queue: "650",
                position: "2",
                channel: "SIP/telco-0002",
                calleridnum: "099333444",
                wait: "3",
            });
            fakeAmi.emit("managerevent", {
                event: "QueueStatusComplete",
                actionid,
                queue: "650",
            });
        });
    };

    const qRes = await pbxService.__test.collectQueueStatusFromAmi(fakeAmi, "650", 1500);
    assert.strictEqual(qRes.ok, true);
    assert.strictEqual(qRes.timedOut, false);
    assert.strictEqual(qRes.params.length, 1);
    assert.strictEqual(qRes.params[0].strategy, "rrmemory");
    assert.strictEqual(qRes.members.length, 2);
    assert.strictEqual(qRes.members[0].extension, "101");
    assert.strictEqual(qRes.members[0].statusLabel, "NOT_INUSE");
    assert.strictEqual(qRes.members[1].paused, true);
    assert.strictEqual(qRes.entries.length, 2);
    assert.strictEqual(qRes.entries[0].callerIdNum, "099111222");

    // Verify QueuePresenceService discovers both SIP/101 and SIP/150 from qRes.events
    const presence = new QueuePresenceService();
    const discovered = presence.recordDiscoveredMembers("650", qRes);
    assert.strictEqual(discovered, 2);

    // Timeout fallback when QueueStatusComplete never arrives
    const silentAmi = new EventEmitter();
    silentAmi.action = (_action, cb) => cb(null, { response: "Success" });
    const timedOutRes = await pbxService.__test.collectQueueStatusFromAmi(silentAmi, "650", 220);
    assert.strictEqual(timedOutRes.ok, true);
    assert.strictEqual(timedOutRes.timedOut, true);

    console.log("v2 asterisk-capabilities & queue-status tests passed");
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});

