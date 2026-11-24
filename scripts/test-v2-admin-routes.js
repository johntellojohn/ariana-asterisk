const assert = require("assert");
const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");

const app = require("../src/app");
const env = require("../src/config/env");
const configStore = require("../src/modules/config/config-store.service");
const adminAuth = require("../src/modules/admin/admin-auth.service");
const auditLog = require("../src/modules/audit/audit-log.service");
const callState = require("../src/modules/pbx/call-state.service");
const webhookDispatcher = require("../src/modules/laravel/webhook-dispatcher.service");

async function request(server, method, reqPath, { body = null, headers = {} } = {}) {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}${reqPath}`;
    const res = await fetch(url, {
        method,
        redirect: "manual",
        headers: {
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch (_err) {
        // html or css or js
    }
    return {
        status: res.status,
        headers: res.headers,
        text,
        json,
    };
}

async function run() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ariana-v2-admin-"));
    env.dataDir = tempDir;

    await configStore.init(env, { dataDir: tempDir });
    await adminAuth.init({
        dataDir: tempDir,
        bootstrapUser: "admin",
        bootstrapPassword: "TestAdminPassword1!",
    });
    await auditLog.init({ dataDir: tempDir, retentionDays: 7 });
    await webhookDispatcher.init({ dataDir: tempDir, auditLogger: auditLog, getTargetConfig: () => ({ enabled: false }) });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
        // 1. Unauthenticated / and /admin redirect to /admin/login; /admin/api/overview returns 401
        const unauthRoot = await request(server, "GET", "/");
        assert.strictEqual(unauthRoot.status, 302);
        assert.strictEqual(unauthRoot.headers.get("location"), "/admin/login");

        const unauthPage = await request(server, "GET", "/admin");
        assert.strictEqual(unauthPage.status, 302);
        assert.strictEqual(unauthPage.headers.get("location"), "/admin/login");

        const unauthApi = await request(server, "GET", "/admin/api/overview");
        assert.strictEqual(unauthApi.status, 401);

        // 2. Login page renders cleanly with zero inline scripts (CSP 'self')
        const loginHtml = await request(server, "GET", "/admin/login");
        assert.strictEqual(loginHtml.status, 200);
        assert.strictEqual(loginHtml.text.includes("<script src=\"/admin/assets/login.js\""), true);
        assert.strictEqual(/<script(?![^>]*src=)/i.test(loginHtml.text), false);

        // 3. Static JS/CSS assets serve properly
        const cssAsset = await request(server, "GET", "/admin/assets/admin.css");
        assert.strictEqual(cssAsset.status, 200);
        assert.ok(cssAsset.headers.get("content-type").includes("text/css"));

        const jsAsset = await request(server, "GET", "/admin/assets/admin.js");
        assert.strictEqual(jsAsset.status, 200);
        assert.ok(jsAsset.headers.get("content-type").includes("application/javascript"));

        // 4. POST /admin/api/login issues HttpOnly session cookie
        const loginRes = await request(server, "POST", "/admin/api/login", {
            body: { username: "admin", password: "TestAdminPassword1!" },
        });
        assert.strictEqual(loginRes.status, 200);
        assert.strictEqual(loginRes.json.ok, true);
        const setCookie = loginRes.headers.get("set-cookie");
        assert.ok(setCookie && setCookie.includes("ariana_admin_session="));
        assert.ok(setCookie.includes("HttpOnly"));
        const cookieHeader = setCookie.split(";")[0];

        // 5. Authenticated / redirects to /admin, and /admin renders with zero inline JS
        const authRoot = await request(server, "GET", "/", {
            headers: { Cookie: cookieHeader },
        });
        assert.strictEqual(authRoot.status, 302);
        assert.strictEqual(authRoot.headers.get("location"), "/admin");

        const adminHtml = await request(server, "GET", "/admin", {
            headers: { Cookie: cookieHeader },
        });
        assert.strictEqual(adminHtml.status, 200);
        assert.strictEqual(adminHtml.text.includes("<script src=\"/admin/assets/admin.js\""), true);
        assert.strictEqual(/<script(?![^>]*src=)/i.test(adminHtml.text), false);
        assert.strictEqual(/\sonclick=/i.test(adminHtml.text), false);
        assert.strictEqual(adminHtml.text.includes("<th>Canal PBX</th>"), true);

        // 6. Overview exposes primary PBX channel & dstChannel for active/recent calls
        callState.reset();
        const seededCall = callState.ensureCall("1795559999.101");
        seededCall.status = "RINGING";
        seededCall.queue = "650";
        seededCall.callerNumber = "0991234567";
        seededCall.targetExtension = "101";
        seededCall.primaryChannel = "SIP/troncal-hospital-000004a2";
        seededCall.channels.add("SIP/troncal-hospital-000004a2");
        seededCall.agentChannels.add("Local/101@ariana-web-agent-0000010f;1");
        seededCall.channels.add("Local/101@ariana-web-agent-0000010f;1");

        const overviewRes = await request(server, "GET", "/admin/api/overview", {
            headers: { Cookie: cookieHeader },
        });
        assert.strictEqual(overviewRes.status, 200);
        assert.strictEqual(overviewRes.json.ok, true);
        assert.ok(overviewRes.json.capabilities && "effectiveAnswerMode" in overviewRes.json.capabilities);
        assert.ok(overviewRes.json.queueSummary && Array.isArray(overviewRes.json.queueSummary.waitingList));
        const trackedCall = overviewRes.json.calls.find((c) => c.linkedid === "1795559999.101");
        assert.ok(trackedCall, "Overview should include tracked call from callState");
        assert.strictEqual(trackedCall.channel, "SIP/troncal-hospital-000004a2");
        assert.strictEqual(trackedCall.dstChannel, "Local/101@ariana-web-agent-0000010f;1");
        assert.strictEqual(trackedCall.isActive, true);

        const healthRes = await request(server, "GET", "/api/health");
        assert.strictEqual(healthRes.status, 200);
        assert.ok(healthRes.json.capabilities && "supportsExternalMedia" in healthRes.json.capabilities);

        const saveCfgRes = await request(server, "POST", "/admin/api/config", {
            headers: { Cookie: cookieHeader },
            body: {
                pbxAmiEnabled: false,
                ariEnabled: false,
                pbxAnswerMode: "extension",
                laravelApiUrl: "https://eva.hospital.local",
                laravelTenantDatabase: "sigcrm_hospital_test",
            },
        });
        assert.strictEqual(saveCfgRes.status, 200);
        assert.strictEqual(saveCfgRes.json.values.laravelTenantDatabase, "sigcrm_hospital_test");
        assert.strictEqual(saveCfgRes.json.values.pbxAnswerMode, "extension");

        // 7. Caja Negra stores channel & dstChannel and supports search on live & JSONL day
        auditLog.record({
            category: "call",
            type: "ENDED",
            linkedid: "1795559999.101",
            channel: "SIP/troncal-hospital-000004a2",
            dstChannel: "Local/101@ariana-web-agent-0000010f;1",
            queue: "650",
            caller: "0991234567",
            agentExtension: "101",
            outcome: "primary_hangup_after_answer",
            summary: "Terminal ENDED (SIP/troncal-hospital-000004a2)",
        });
        await auditLog.flush();

        const auditRes = await request(server, "GET", "/admin/api/audit?day=live&search=000004a2", {
            headers: { Cookie: cookieHeader },
        });
        assert.strictEqual(auditRes.status, 200);
        assert.strictEqual(auditRes.json.entries.length, 1);
        assert.strictEqual(auditRes.json.entries[0].channel, "SIP/troncal-hospital-000004a2");
        assert.strictEqual(auditRes.json.entries[0].dstChannel, "Local/101@ariana-web-agent-0000010f;1");

        const todayStamp = new Date().toISOString().slice(0, 10);
        const auditDayRes = await request(server, "GET", `/admin/api/audit?day=${todayStamp}&search=000004a2`, {
            headers: { Cookie: cookieHeader },
        });
        assert.strictEqual(auditDayRes.status, 200);
        assert.strictEqual(auditDayRes.json.entries.length, 1);
        assert.strictEqual(auditDayRes.json.entries[0].channel, "SIP/troncal-hospital-000004a2");

        // 8. Manual channel hangup endpoint enforces auth, validation, and AMI connection guard
        const unauthHangup = await request(server, "POST", "/admin/api/channels/hangup", {
            body: { channel: "SIP/troncal-hospital-000004a2" },
        });
        assert.strictEqual(unauthHangup.status, 401);

        const badChannelHangup = await request(server, "POST", "/admin/api/channels/hangup", {
            headers: { Cookie: cookieHeader },
            body: { channel: "SIP/troncal\r\nAction: Logoff" },
        });
        assert.strictEqual(badChannelHangup.status, 400);

        const disconnectedAmiHangup = await request(server, "POST", "/admin/api/channels/hangup", {
            headers: { Cookie: cookieHeader },
            body: { channel: "SIP/troncal-hospital-000004a2", linkedid: "1795559999.101" },
        });
        assert.strictEqual(disconnectedAmiHangup.status, 503);

        console.log("v2 admin routes, channel blackbox & hangup tests passed");
    } finally {
        callState.reset();
        webhookDispatcher.stop();
        auditLog.stop();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});

