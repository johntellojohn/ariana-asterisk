const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { ConfigStoreService } = require("../src/modules/config/config-store.service");
const { AdminAuthService } = require("../src/modules/admin/admin-auth.service");

async function run() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ariana-v2-cfg-"));

    try {
        const fakeEnv = {
            nodeEnv: "production",
            port: 3002,
            appName: "Ariana Asterisk Gateway",
            publicBaseUrl: "http://localhost:3002",
            corsOrigins: ["*"],
            asteriskApiToken: "",
            logLevel: "info",
            dataDir: tempDir,
            configMasterKey: "test-master-passphrase",
            laravelApiUrl: "http://localhost",
            laravelApiToken: "",
            laravelVoiceToolsToken: "",
            laravelTenantDatabase: "",
            laravelTrunkEventsEnabled: true,
            laravelTrunkEventsPath: "/api/trunk-calls/events",
            laravelCallbackTimeoutMs: 30000,
            laravelHeartbeatEnabled: true,
            laravelHeartbeatPath: "/api/trunk-calls/heartbeat",
            laravelHeartbeatIntervalMs: 60000,
            pbxAmiEnabled: true,
            pbxAmiHost: "127.0.0.1",
            pbxAmiPort: 5038,
            pbxAmiUsername: "",
            pbxAmiPassword: "",
            pbxAmiReconnect: true,
            pbxAmiEventMask: "on",
            ariEnabled: true,
            ariBaseUrl: "http://127.0.0.1:8088",
            ariWsUrl: "",
            ariUsername: "",
            ariPassword: "",
            ariAppName: "ariana-trunk",
            ariExternalMediaPortStart: 46000,
            ariExternalMediaPortEnd: 46100,
        };

        // 1. Fresh boot without .env PBX/EVA credentials starts in pending-setup mode
        const store = new ConfigStoreService();
        const initialStatus = await store.init(fakeEnv, { dataDir: tempDir });
        assert.strictEqual(initialStatus.configured, false);
        assert.strictEqual(initialStatus.source, "pending-setup");
        assert.strictEqual(store.isAmiReady(), false);
        assert.strictEqual(store.isAriReady(), false);

        // 2. Update config via UI payload, verify hot-reload onto env & encryption on disk
        const updateResult = await store.updateConfig({
            pbxAmiHost: "192.168.100.34",
            pbxAmiUsername: "middleware",
            pbxAmiPassword: "super-secret-ami-password",
            ariBaseUrl: "http://192.168.100.34:8088",
            ariUsername: "ariana",
            ariPassword: "ari-secret-password",
            laravelApiUrl: "https://eva.sigcrm.com/",
            laravelApiToken: "eva-token-987654",
            laravelTenantDatabase: "sigcrm_hospital",
        });

        assert.strictEqual(updateResult.amiChanged, true);
        assert.strictEqual(updateResult.ariChanged, true);
        assert.strictEqual(updateResult.evaChanged, true);
        assert.strictEqual(updateResult.status.configured, true);
        assert.strictEqual(fakeEnv.pbxAmiHost, "192.168.100.34");
        assert.strictEqual(fakeEnv.laravelApiUrl, "https://eva.sigcrm.com");
        assert.strictEqual(fakeEnv.laravelApiToken, "eva-token-987654");

        // Ensure secrets are masked cleanly and preserved if masked value is sent back
        const masked = store.getPublicConfig();
        assert.strictEqual(masked.secretsSet.pbxAmiPassword, true);
        assert.strictEqual(masked.values.pbxAmiPassword.startsWith("****"), true);
        assert.strictEqual(masked.values.pbxAmiPassword.includes("super-secret"), false);

        await store.updateConfig({
            pbxAmiPassword: masked.values.pbxAmiPassword,
            pbxAmiPort: 5039,
        });
        assert.strictEqual(fakeEnv.pbxAmiPassword, "super-secret-ami-password");
        assert.strictEqual(fakeEnv.pbxAmiPort, 5039);

        // Verify disk file is encrypted (plaintext password must not appear)
        const diskRaw = await fs.readFile(path.join(tempDir, "config.enc.json"), "utf8");
        assert.strictEqual(diskRaw.includes("super-secret-ami-password"), false);
        assert.strictEqual(diskRaw.includes("eva-token-987654"), false);

        // Reload in new ConfigStoreService instance from disk
        const reloadedEnv = { ...fakeEnv, pbxAmiHost: "", laravelApiToken: "", pbxAmiPassword: "" };
        const store2 = new ConfigStoreService();
        const status2 = await store2.init(reloadedEnv, { dataDir: tempDir });
        assert.strictEqual(status2.source, "disk");
        assert.strictEqual(status2.configured, true);
        assert.strictEqual(reloadedEnv.pbxAmiHost, "192.168.100.34");
        assert.strictEqual(reloadedEnv.pbxAmiPassword, "super-secret-ami-password");
        assert.strictEqual(reloadedEnv.laravelApiToken, "eva-token-987654");

        // 3. Autonomous AdminAuthService: bootstrap, login, cookie verification, credential rotation, rate limit
        const auth = new AdminAuthService();
        await auth.init({
            dataDir: tempDir,
            bootstrapUser: "operador",
            bootstrapPassword: "InitialPassword123!",
        });

        const failLogin = await auth.login("operador", "wrong", "10.0.0.5");
        assert.strictEqual(failLogin.ok, false);
        assert.strictEqual(failLogin.status, 401);

        const okLogin = await auth.login("operador", "InitialPassword123!", "10.0.0.5");
        assert.strictEqual(okLogin.ok, true);
        assert.ok(okLogin.token);
        const verified = auth.verifySessionToken(okLogin.token);
        assert.strictEqual(verified.sub, "operador");
        assert.strictEqual(auth.verifySessionToken(`${okLogin.token}tamper`), null);

        // Change credentials
        const rotated = await auth.changeCredentials({
            currentPassword: "InitialPassword123!",
            newUsername: "admin-hospital",
            newPassword: "NewStrongPassword99!",
        });
        assert.strictEqual(rotated.ok, true);
        // Old user token becomes invalid immediately after username rotation
        assert.strictEqual(auth.verifySessionToken(okLogin.token), null);
        assert.strictEqual(auth.verifySessionToken(rotated.token).sub, "admin-hospital");

        const newLogin = await auth.login("admin-hospital", "NewStrongPassword99!", "10.0.0.5");
        assert.strictEqual(newLogin.ok, true);

        // Rate limit verification after 10 failures from distinct IP
        for (let i = 0; i < 10; i += 1) {
            const attempt = await auth.login("admin-hospital", "bad-pass", "10.0.0.99");
            assert.strictEqual(attempt.ok, false);
            assert.strictEqual(attempt.status, 401);
        }
        const blocked = await auth.login("admin-hospital", "NewStrongPassword99!", "10.0.0.99");
        assert.strictEqual(blocked.ok, false);
        assert.strictEqual(blocked.status, 429);

        console.log("v2 config-store & admin-auth tests passed");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});

