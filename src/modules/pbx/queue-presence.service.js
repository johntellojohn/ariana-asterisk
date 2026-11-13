/**
 * Manages Asterisk QueuePause state using delta-only updates and dynamically
 * discovered QueueStatus interfaces so AMI avoids redundant bursts across agents.
 */
class QueuePresenceService {
    constructor() {
        this.stateByKey = new Map();
        this.interfaceByKey = new Map();
        this.lastDiscoveryAtByQueue = new Map();
    }

    static extractExtension(value) {
        if (!value) return "";
        const raw = String(value).trim();
        if (/^\d{2,6}$/.test(raw)) return raw;
        const match = /(?:SIP|PJSIP|Local)\/(\d{2,6})(?:[@\-\/;,]|$)/i.exec(raw);
        return match ? match[1] : "";
    }

    static buildCandidateInterfaces(extension) {
        const clean = String(extension || "").trim();
        return [
            `Local/${clean}@from-queue/n`,
            `Local/${clean}@simulador-agente/n`,
            `PJSIP/${clean}`,
            `SIP/${clean}`,
        ];
    }

    recordDiscoveredMembers(queue, amiResponse) {
        const events = Array.isArray(amiResponse?.events)
            ? amiResponse.events
            : Array.isArray(amiResponse)
                ? amiResponse
                : [];

        let updated = 0;

        for (const item of events) {
            const eventName = String(item?.event || item?.Event || "").toLowerCase();
            if (eventName !== "queuemember") continue;

            const memberQueue = String(item.queue || item.Queue || queue || "650").trim();
            const iface = String(item.location || item.Location || item.name || item.Name || item.stateinterface || "").trim();
            const ext = QueuePresenceService.extractExtension(iface || item.name || item.Name);

            if (ext && iface) {
                this.interfaceByKey.set(`${memberQueue}:${ext}`, iface);
                updated += 1;
            }
        }

        if (updated > 0) {
            this.lastDiscoveryAtByQueue.set(String(queue || "650"), Date.now());
        }

        return updated;
    }

    async pauseMemberWithDiscovery({ queue = "650", extension, paused, reason = "", runAmiAction }) {
        const cleanQueue = String(queue || "650").trim();
        const cleanExt = QueuePresenceService.extractExtension(extension);

        if (!cleanExt) {
            return { ok: false, skipped: true, reason: "invalid_extension" };
        }

        const cacheKey = `${cleanQueue}:${cleanExt}`;
        const cachedIface = this.interfaceByKey.get(cacheKey);
        const candidates = cachedIface
            ? [cachedIface, ...QueuePresenceService.buildCandidateInterfaces(cleanExt).filter((c) => c !== cachedIface)]
            : QueuePresenceService.buildCandidateInterfaces(cleanExt);

        const attempts = [];

        for (const iface of candidates) {
            try {
                const response = await runAmiAction({
                    Action: "QueuePause",
                    Interface: iface,
                    Paused: paused ? "true" : "false",
                    Queue: cleanQueue,
                    ...(reason ? { Reason: reason } : {}),
                });

                this.interfaceByKey.set(cacheKey, iface);
                return {
                    ok: true,
                    interface: iface,
                    attempts: attempts.length + 1,
                    response,
                };
            } catch (error) {
                attempts.push({ interface: iface, error: error.message });
                if (iface === cachedIface) {
                    this.interfaceByKey.delete(cacheKey);
                }
            }
        }

        return {
            ok: false,
            extension: cleanExt,
            queue: cleanQueue,
            attempts,
            error: attempts.length ? attempts[attempts.length - 1].error : "QueuePause failed for all interfaces",
        };
    }

    async syncDelta({
        queue = "650",
        onlineExtensions = [],
        allExtensions = [],
        force = false,
        isExtensionBusy = () => false,
        runAmiAction,
        fetchQueueStatus = null,
    }) {
        const cleanQueue = String(queue || "650").trim();
        const onlineSet = new Set(
            (Array.isArray(onlineExtensions) ? onlineExtensions : [])
                .map((ext) => QueuePresenceService.extractExtension(ext))
                .filter(Boolean)
        );

        const allSet = new Set(
            (Array.isArray(allExtensions) ? allExtensions : [])
                .map((ext) => QueuePresenceService.extractExtension(ext))
                .filter(Boolean)
        );

        for (const ext of onlineSet) {
            allSet.add(ext);
        }

        // Refresh member interface mapping via QueueStatus if stale (> 5 min) or unknown
        const lastDiscovery = this.lastDiscoveryAtByQueue.get(cleanQueue) || 0;
        if (typeof fetchQueueStatus === "function" && Date.now() - lastDiscovery > 5 * 60 * 1000) {
            try {
                const statusRes = await fetchQueueStatus(cleanQueue);
                this.recordDiscoveredMembers(cleanQueue, statusRes);
            } catch (_err) {
                // Fallback gracefully to candidate probing
            }
        }

        const results = [];
        let changedCount = 0;
        let skippedCount = 0;

        for (const ext of allSet) {
            const busy = Boolean(isExtensionBusy(ext));
            const desiredOnline = onlineSet.has(ext) && !busy;
            const desiredPaused = !desiredOnline;
            const reason = desiredOnline ? "online_eva" : busy ? "in_call_eva" : "offline_eva";

            const stateKey = `${cleanQueue}:${ext}`;
            const nextStateSignature = `${desiredPaused ? "1" : "0"}:${reason}`;
            const prevSignature = this.stateByKey.get(stateKey);

            if (!force && prevSignature === nextStateSignature) {
                skippedCount += 1;
                results.push({
                    extension: ext,
                    isOnline: desiredOnline,
                    paused: desiredPaused,
                    skipped: true,
                    ok: true,
                });
                continue;
            }

            const res = await this.pauseMemberWithDiscovery({
                queue: cleanQueue,
                extension: ext,
                paused: desiredPaused,
                reason,
                runAmiAction,
            });

            if (res.ok) {
                this.stateByKey.set(stateKey, nextStateSignature);
                changedCount += 1;
            }

            results.push({
                extension: ext,
                isOnline: desiredOnline,
                paused: desiredPaused,
                skipped: false,
                ok: res.ok,
                interface: res.interface || null,
                error: res.error || null,
            });
        }

        return {
            queue: cleanQueue,
            online: Array.from(onlineSet),
            all: Array.from(allSet),
            changedCount,
            skippedCount,
            results,
        };
    }

    reset() {
        this.stateByKey.clear();
        this.interfaceByKey.clear();
        this.lastDiscoveryAtByQueue.clear();
    }
}

const instance = new QueuePresenceService();

module.exports = instance;
module.exports.QueuePresenceService = QueuePresenceService;

