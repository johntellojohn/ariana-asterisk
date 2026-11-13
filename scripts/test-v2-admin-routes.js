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
        // 1. Unauthenticated /admin redirects to /admin/login; /admin/api/overview returns 401
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

        // 5. Authenticated /admin page renders with zero inline JS
        const adminHtml = await request(server, "GET", "/admin", {
            headers: { Cookie: cookieHeader },
        });
        assert.strictEqual(adminHtml.status, 200);
        assert.strictEqual(adminHtml.text.includes("<script src=\"/admin/assets/admin.js\""), true);
        assert.strictEqual(/<script(?![^>]*src=)/i.test(adminHtml.text), false);

        // 6. Overview, config save (disabled AMI/ARI so no external socket attempt), & audit endpoints work
        const overviewRes = await request(server, "GET", "/admin/api/overview", {
            headers: { Cookie: cookieHeader },
        });
        assert.strictEqual(overviewRes.status, 200);
        assert.strictEqual(overviewRes.json.ok, true);

        const saveCfgRes = await request(server, "POST", "/admin/api/config", {
            headers: { Cookie: cookieHeader },
            body: {
                pbxAmiEnabled: false,
                ariEnabled: false,
                laravelApiUrl: "https://eva.hospital.local",
                laravelTenantDatabase: "sigcrm_hospital_test",
            },
        });
        assert.strictEqual(saveCfgRes.status, 200);
        assert.strictEqual(saveCfgRes.json.values.laravelTenantDatabase, "sigcrm_hospital_test");

        const auditRes = await request(server, "GET", "/admin/api/audit", {
            headers: { Cookie: cookieHeader },
        });
        assert.strictEqual(auditRes.status, 200);
        assert.ok(auditRes.json.entries.some((e) => e.type === "config_updated"));

        console.log("v2 admin routes & CSP tests passed");
    } finally {
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

