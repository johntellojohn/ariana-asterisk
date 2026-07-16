class SpeechInterruptionGate {
    constructor(options = {}) {
        this.debounceMs = Math.max(0, Number(options.debounceMs || 0));
        this.onInterrupt = options.onInterrupt || (() => {});
        this.onIgnored = options.onIgnored || (() => {});
        this.shouldInterrupt = options.shouldInterrupt || (() => true);
        this.pendingTimer = null;
        this.pendingReason = null;
    }

    speechStarted(reason = "caller_speech_started") {
        if (this.pendingTimer) {
            return;
        }

        if (this.debounceMs <= 0) {
            this.interruptIfConfirmed(reason);
            return;
        }

        this.pendingReason = reason;
        this.pendingTimer = setTimeout(() => {
            const interruptReason = this.pendingReason || reason;
            this.pendingTimer = null;
            this.pendingReason = null;
            this.interruptIfConfirmed(interruptReason);
        }, this.debounceMs);

        if (typeof this.pendingTimer.unref === "function") {
            this.pendingTimer.unref();
        }
    }

    speechStopped(reason = "speech_stopped") {
        if (!this.pendingTimer) {
            return;
        }

        this.cancelPending();
        this.onIgnored(reason);
    }

    cancelPending() {
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
        }

        this.pendingTimer = null;
        this.pendingReason = null;
    }

    interruptIfConfirmed(reason) {
        if (!this.shouldInterrupt()) {
            this.onIgnored("speech_not_confirmed");
            return;
        }

        this.onInterrupt(reason);
    }
}

module.exports = {
    SpeechInterruptionGate,
};
