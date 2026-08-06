const env = require("../../config/env");

const PCM_SAMPLE_RATE = 48000;
const DISCONNECT_TONE_FREQUENCIES = [350, 400, 425, 440, 450, 480, 620];

function createFrame(pcm48, at = Date.now()) {
    return {
        at,
        durationMs: (pcm48.length / 2 / PCM_SAMPLE_RATE) * 1000,
        level: calculatePcm16Rms(pcm48),
    };
}

function track(state, pcm48, frame, options = {}) {
    if (options.enabled === false || state.disconnectToneClosed) {
        return { shouldClose: false, suppressRealtime: false };
    }

    if (options.hasOutput === false) {
        return { shouldClose: false, suppressRealtime: false };
    }

    const durationMs = Math.max(1, frame.durationMs || 0);
    const tone = detect(pcm48, frame);
    const cadence = trackCadence(state, tone, durationMs, frame.at);

    if (tone.detected) {
        state.disconnectToneMs = (state.disconnectToneMs || 0) + durationMs;
        state.disconnectToneLastAt = frame.at;
    } else {
        state.disconnectToneMs = Math.max(0, (state.disconnectToneMs || 0) - (durationMs * 0.65));
    }

    const suppressRealtime = state.disconnectToneMs >= env.trunkAiDisconnectToneSuppressMs;

    if (cadence.shouldClose) {
        return {
            shouldClose: true,
            suppressRealtime: true,
            reason: {
                detection: "cadence",
                bursts: cadence.bursts,
                burstMs: cadence.burstMs,
                gapMs: cadence.gapMs,
                confidence: Number(tone.confidence.toFixed(4)),
                level: Number(frame.level.toFixed(5)),
                frequency: tone.frequency,
            },
        };
    }

    if (state.disconnectToneMs < env.trunkAiDisconnectToneMinMs) {
        return { shouldClose: false, suppressRealtime };
    }

    return {
        shouldClose: true,
        suppressRealtime: true,
        reason: {
            detection: "sustained",
            toneMs: Math.round(state.disconnectToneMs),
            confidence: Number(tone.confidence.toFixed(4)),
            level: Number(frame.level.toFixed(5)),
            frequency: tone.frequency,
        },
    };
}

function trackCadence(state, tone, durationMs, at = Date.now()) {
    if (!env.trunkAiDisconnectToneCadenceEnabled) {
        return { shouldClose: false };
    }

    const now = Number(at) || Date.now();
    const windowMs = Math.max(1, env.trunkAiDisconnectToneWindowMs);

    if (state.disconnectToneCadenceStartedAt
        && now - state.disconnectToneCadenceStartedAt > windowMs) {
        resetCadence(state);
    }

    if (!tone.detected) {
        if (state.disconnectToneCadenceStartedAt) {
            state.disconnectToneGapMs = (state.disconnectToneGapMs || 0) + durationMs;

            if (state.disconnectToneGapMs > env.trunkAiDisconnectToneGapMaxMs) {
                resetCadence(state);
            }
        }

        return { shouldClose: false };
    }

    if (!state.disconnectToneCadenceStartedAt) {
        state.disconnectToneCadenceStartedAt = now;
    }

    const previousGapMs = state.disconnectToneGapMs || 0;

    if (previousGapMs >= env.trunkAiDisconnectToneGapMinMs) {
        const validGap = previousGapMs <= env.trunkAiDisconnectToneGapMaxMs;
        const validBurst = state.disconnectToneBurstQualified;
        const matchingFrequency = frequenciesMatch(
            state.disconnectToneReferenceFrequency,
            tone.frequency
        );

        if (!validGap || !validBurst || !matchingFrequency) {
            resetCadence(state);
            state.disconnectToneCadenceStartedAt = now;
        } else {
            state.disconnectToneLastGapMs = previousGapMs;
            state.disconnectToneBurstMs = 0;
            state.disconnectToneBurstFrequency = tone.frequency;
            state.disconnectToneBurstQualified = false;
        }
    }

    state.disconnectToneGapMs = 0;
    state.disconnectToneBurstMs = (state.disconnectToneBurstMs || 0) + durationMs;
    state.disconnectToneBurstFrequency ??= tone.frequency;

    if (!state.disconnectToneBurstQualified
        && state.disconnectToneBurstMs >= env.trunkAiDisconnectToneBurstMinMs) {
        if (!frequenciesMatch(state.disconnectToneReferenceFrequency, tone.frequency)) {
            resetCadence(state);
            state.disconnectToneCadenceStartedAt = now;
            state.disconnectToneBurstMs = durationMs;
            state.disconnectToneBurstFrequency = tone.frequency;
            return { shouldClose: false };
        }

        state.disconnectToneBurstQualified = true;
        state.disconnectToneBursts = (state.disconnectToneBursts || 0) + 1;
        state.disconnectToneReferenceFrequency ??= state.disconnectToneBurstFrequency;
    }

    return {
        shouldClose: state.disconnectToneBursts >= Math.max(2, env.trunkAiDisconnectToneBurstsRequired),
        bursts: state.disconnectToneBursts,
        burstMs: Math.round(state.disconnectToneBurstMs),
        gapMs: Math.round(state.disconnectToneLastGapMs || previousGapMs),
    };
}

function reset(state) {
    state.disconnectToneMs = 0;
    state.disconnectToneLastAt = 0;
    resetCadence(state);
}

function resetCadence(state) {
    state.disconnectToneBurstMs = 0;
    state.disconnectToneGapMs = 0;
    state.disconnectToneLastGapMs = 0;
    state.disconnectToneBursts = 0;
    state.disconnectToneCadenceStartedAt = 0;
    state.disconnectToneBurstFrequency = null;
    state.disconnectToneReferenceFrequency = null;
    state.disconnectToneBurstQualified = false;
}

function detect(pcm48, frame) {
    const level = frame.level || 0;

    if (level < env.trunkAiDisconnectToneRmsThreshold) {
        return { detected: false, confidence: 0, frequency: null };
    }

    const sampleRate = 8000;
    const samples = downsamplePcm16ToFloat(pcm48, PCM_SAMPLE_RATE / sampleRate);

    if (samples.length < 80) {
        return { detected: false, confidence: 0, frequency: null };
    }

    const spectrum = strongestToneRatio(samples, sampleRate, DISCONNECT_TONE_FREQUENCIES);

    return {
        detected: spectrum.ratio >= env.trunkAiDisconnectToneRatioThreshold,
        confidence: spectrum.ratio,
        frequency: spectrum.frequency,
    };
}

function frequenciesMatch(reference, candidate) {
    if (!Number.isFinite(reference) || !Number.isFinite(candidate)) {
        return true;
    }

    return Math.abs(reference - candidate) <= env.trunkAiDisconnectToneFrequencyToleranceHz;
}

function downsamplePcm16ToFloat(buffer, step) {
    const stride = Math.max(1, Math.round(step));
    const values = [];
    let total = 0;

    for (let offset = 0; offset + 1 < buffer.length; offset += 2 * stride) {
        const value = buffer.readInt16LE(offset) / 32768;
        values.push(value);
        total += value;
    }

    if (!values.length) {
        return values;
    }

    const mean = total / values.length;

    return values.map((value) => value - mean);
}

function strongestToneRatio(samples, sampleRate, frequencies) {
    const totalEnergy = samples.reduce((total, sample) => total + (sample * sample), 0);

    if (totalEnergy <= 0) {
        return { ratio: 0, frequency: null };
    }

    let best = { ratio: 0, frequency: null };

    for (const frequency of frequencies) {
        const power = goertzelPower(samples, sampleRate, frequency);
        const ratio = power / (totalEnergy * samples.length);

        if (ratio > best.ratio) {
            best = { ratio, frequency };
        }
    }

    return best;
}

function goertzelPower(samples, sampleRate, frequency) {
    const omega = (2 * Math.PI * frequency) / sampleRate;
    const coeff = 2 * Math.cos(omega);
    let q0 = 0;
    let q1 = 0;
    let q2 = 0;

    for (const sample of samples) {
        q0 = (coeff * q1) - q2 + sample;
        q2 = q1;
        q1 = q0;
    }

    return (q1 * q1) + (q2 * q2) - (coeff * q1 * q2);
}

function calculatePcm16Rms(buffer) {
    const samples = Math.floor(buffer.length / 2);

    if (samples <= 0) {
        return 0;
    }

    let sumSquares = 0;

    for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
        const sample = buffer.readInt16LE(offset) / 32768;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}

module.exports = {
    createFrame,
    track,
    trackCadence,
    reset,
};
