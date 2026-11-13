const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const AUTH_FILE_NAME = "auth.json";
const SESSION_KEY_FILE_NAME = ".session.key";
const COOKIE_NAME = "ariana_admin_session";
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

function parseCookies(cookieHeader) {
    const parsed = {};

    if (!cookieHeader || typeof cookieHeader !== "string") {
        return parsed;
    }

    for (const part of cookieHeader.split(";")) {
        const idx = part.indexOf("=");
        if (idx <= 0) {
            continue;
        }
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        try {
            parsed[name] = decodeURIComponent(value);
        } catch (_error) {
            parsed[name] = value;
        }
    }

    return parsed;
}

function hashPasswordScrypt(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function verifyPasswordScrypt(password, salt, expectedHex) {
    const derived = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(expectedHex, "hex");
    if (derived.length !== expected.length) {
        return false;
    }
    return crypto.timingSafeEqual(derived, expected);
}

async function atomicWriteJson(filePath, payload) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
}

/**
 * Autonomous local authentication for /admin using scrypt credentials in DATA_DIR
 * and HMAC-SHA256 signed HttpOnly cookies (no external auth dependency).
 */
class AdminAuthService {
    constructor() {
        this.initialized = false;
        this.dataDir = null;
        this.sessionSecret = null;
        this.sessionTtlMs = 12 * 60 * 60 * 1000;
        this.account = null;
        this.attemptsByIp = new Map();
    }

    async init(options = {}) {
        this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
        this.sessionTtlMs = Number(options.sessionTtlMs) > 60000
            ? Number(options.sessionTtlMs)
            : 12 * 60 * 60 * 1000;

        await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        this.sessionSecret = await this.resolveSessionSecret(options.sessionSecret);

        const authPath = path.join(this.dataDir, AUTH_FILE_NAME);

        try {
            const raw = await fs.readFile(authPath, "utf8");
            this.account = JSON.parse(raw);
        } catch (error) {
            if (error && error.code !== "ENOENT") {
                throw error;
            }

            const username = (options.bootstrapUser || "admin").trim() || "admin";
            const envPassword = options.bootstrapPassword ? String(options.bootstrapPassword).trim() : "";
            const initialPassword = envPassword || "ArianaAdmin2026!";
            const mustChangePassword = !envPassword;
            const salt = crypto.randomBytes(16).toString("hex");
            const now = new Date().toISOString();

            this.account = {
                version: 1,
                username,
                salt,
                passwordHash: hashPasswordScrypt(initialPassword, salt),
                role: "admin",
                mustChangePassword,
                createdAt: now,
                updatedAt: now,
            };

            await atomicWriteJson(authPath, this.account);

            if (mustChangePassword) {
                console.warn(
                    `[AdminAuth] Initialized default admin account '${username}' with temporary password. Set ADMIN_BOOTSTRAP_PASSWORD or update it in /admin.`
                );
            }
        }

        this.initialized = true;
    }

    async resolveSessionSecret(configuredSecret) {
        if (configuredSecret && String(configuredSecret).trim()) {
            return crypto.createHash("sha256").update(String(configuredSecret).trim()).digest();
        }

        const keyPath = path.join(this.dataDir, SESSION_KEY_FILE_NAME);

        try {
            const hex = (await fs.readFile(keyPath, "utf8")).trim();
            if (/^[0-9a-f]{64}$/i.test(hex)) {
                return Buffer.from(hex, "hex");
            }
        } catch (error) {
            if (error && error.code !== "ENOENT") {
                throw error;
            }
        }

        const generated = crypto.randomBytes(32);
        const tmpPath = `${keyPath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmpPath, generated.toString("hex"), { encoding: "utf8", mode: 0o600 });
        await fs.rename(tmpPath, keyPath);
        return generated;
    }

    pruneAttempts(now = Date.now()) {
        if (this.attemptsByIp.size < 200) {
            return;
        }

        for (const [ip, entry] of this.attemptsByIp.entries()) {
            if (now - entry.windowStart > LOGIN_WINDOW_MS) {
                this.attemptsByIp.delete(ip);
            }
        }
    }

    checkRateLimit(ipAddress = "unknown") {
        const now = Date.now();
        this.pruneAttempts(now);
        const entry = this.attemptsByIp.get(ipAddress);

        if (!entry) {
            return { allowed: true, retryAfterSeconds: 0 };
        }

        if (now - entry.windowStart > LOGIN_WINDOW_MS) {
            this.attemptsByIp.delete(ipAddress);
            return { allowed: true, retryAfterSeconds: 0 };
        }

        if (entry.count >= MAX_LOGIN_ATTEMPTS) {
            const remainingMs = LOGIN_WINDOW_MS - (now - entry.windowStart);
            return {
                allowed: false,
                retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
            };
        }

        return { allowed: true, retryAfterSeconds: 0 };
    }

    recordFailedAttempt(ipAddress = "unknown") {
        const now = Date.now();
        const entry = this.attemptsByIp.get(ipAddress);

        if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
            this.attemptsByIp.set(ipAddress, { count: 1, windowStart: now });
            return;
        }

        entry.count += 1;
    }

    clearFailedAttempts(ipAddress = "unknown") {
        this.attemptsByIp.delete(ipAddress);
    }

    verifyCredentials(username, password) {
        if (!this.account || !username || !password) {
            return false;
        }

        if (String(username).trim() !== this.account.username) {
            return false;
        }

        return verifyPasswordScrypt(password, this.account.salt, this.account.passwordHash);
    }

    async login(username, password, ipAddress = "unknown") {
        if (!this.initialized) {
            throw new Error("AdminAuthService is not initialized");
        }

        const rate = this.checkRateLimit(ipAddress);
        if (!rate.allowed) {
            return {
                ok: false,
                status: 429,
                error: "Demasiados intentos fallidos. Intenta nuevamente más tarde.",
                retryAfterSeconds: rate.retryAfterSeconds,
            };
        }

        const valid = this.verifyCredentials(username, password);
        if (!valid) {
            this.recordFailedAttempt(ipAddress);
            return {
                ok: false,
                status: 401,
                error: "Usuario o contraseña incorrectos.",
            };
        }

        this.clearFailedAttempts(ipAddress);
        const token = this.issueSessionToken(this.account.username, this.account.role);

        return {
            ok: true,
            status: 200,
            token,
            user: this.getPublicUser(),
        };
    }

    async changeCredentials({ currentPassword, newUsername, newPassword }) {
        if (!this.initialized) {
            throw new Error("AdminAuthService is not initialized");
        }

        if (!verifyPasswordScrypt(currentPassword || "", this.account.salt, this.account.passwordHash)) {
            return { ok: false, status: 401, error: "La contraseña actual no coincide." };
        }

        const targetUsername = newUsername && String(newUsername).trim()
            ? String(newUsername).trim()
            : this.account.username;

        if (newPassword !== undefined && newPassword !== null && String(newPassword).trim() !== "") {
            const candidate = String(newPassword);
            if (candidate.length < 8) {
                return { ok: false, status: 422, error: "La nueva contraseña debe tener al menos 8 caracteres." };
            }
            const salt = crypto.randomBytes(16).toString("hex");
            this.account.salt = salt;
            this.account.passwordHash = hashPasswordScrypt(candidate, salt);
            this.account.mustChangePassword = false;
        }

        this.account.username = targetUsername;
        this.account.updatedAt = new Date().toISOString();

        const authPath = path.join(this.dataDir, AUTH_FILE_NAME);
        await atomicWriteJson(authPath, this.account);

        return {
            ok: true,
            status: 200,
            token: this.issueSessionToken(this.account.username, this.account.role),
            user: this.getPublicUser(),
        };
    }

    issueSessionToken(username, role = "admin") {
        const now = Date.now();
        const payload = {
            sub: username,
            role,
            iat: now,
            exp: now + this.sessionTtlMs,
            jti: crypto.randomBytes(8).toString("hex"),
        };

        const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
        const signature = crypto
            .createHmac("sha256", this.sessionSecret)
            .update(encoded)
            .digest("base64url");

        return `${encoded}.${signature}`;
    }

    verifySessionToken(token) {
        if (!token || typeof token !== "string" || !this.sessionSecret) {
            return null;
        }

        const parts = token.split(".");
        if (parts.length !== 2) {
            return null;
        }

        const [encoded, providedSig] = parts;
        const expectedSig = crypto
            .createHmac("sha256", this.sessionSecret)
            .update(encoded)
            .digest("base64url");

        const providedBuf = Buffer.from(providedSig, "utf8");
        const expectedBuf = Buffer.from(expectedSig, "utf8");

        if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
            return null;
        }

        try {
            const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
            if (!payload || !payload.exp || Date.now() > payload.exp) {
                return null;
            }
            if (!this.account || payload.sub !== this.account.username) {
                return null;
            }
            return payload;
        } catch (_error) {
            return null;
        }
    }

    extractSessionFromRequest(req) {
        const cookies = parseCookies(req.headers ? req.headers.cookie : "");
        const token = cookies[COOKIE_NAME] || (req.headers ? req.headers["x-admin-session"] : null);
        return this.verifySessionToken(token);
    }

    setSessionCookie(res, token, req = null) {
        const isSecure = Boolean(
            req && (req.secure || req.headers["x-forwarded-proto"] === "https")
        );
        const maxAgeSeconds = Math.floor(this.sessionTtlMs / 1000);
        const attributes = [
            `${COOKIE_NAME}=${encodeURIComponent(token)}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            `Max-Age=${maxAgeSeconds}`,
        ];

        if (isSecure) {
            attributes.push("Secure");
        }

        res.setHeader("Set-Cookie", attributes.join("; "));
    }

    clearSessionCookie(res) {
        res.setHeader(
            "Set-Cookie",
            `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
        );
    }

    getPublicUser() {
        if (!this.account) {
            return null;
        }

        return {
            username: this.account.username,
            role: this.account.role,
            mustChangePassword: Boolean(this.account.mustChangePassword),
            updatedAt: this.account.updatedAt,
        };
    }

    requireAdminAuth(mode = "api") {
        return (req, res, next) => {
            const session = this.extractSessionFromRequest(req);
            if (!session) {
                if (mode === "page") {
                    return res.redirect("/admin/login");
                }
                return res.status(401).json({
                    ok: false,
                    message: "Sesión administrativa requerida.",
                });
            }

            req.adminSession = session;
            return next();
        };
    }
}

const instance = new AdminAuthService();

module.exports = instance;
module.exports.AdminAuthService = AdminAuthService;
module.exports.COOKIE_NAME = COOKIE_NAME;

