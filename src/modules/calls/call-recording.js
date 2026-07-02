const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const env = require("../../config/env");
const sttService = require("../stt/stt.service");
const laravelService = require("../laravel/laravel.service");
const { createWavBuffer } = require("./wav.util");

const SAMPLE_RATE = 48000;
const BYTES_PER_SAMPLE = 2;
const TRANSCRIPTION_FRAME_MS = 30;
const TRANSCRIPTION_MIN_SPEECH_MS = 240;
const TRANSCRIPTION_END_SILENCE_MS = 480;
const TRANSCRIPTION_PADDING_MS = 180;
const TRANSCRIPTION_MAX_SEGMENT_MS = 15000;
const CHANNELS = {
    customer: {
        label: "Cliente",
        side: "customer",
    },
    agent: {
        label: "Agente",
        side: "agent",
    },
};

class CallRecording {
    constructor(options = {}) {
        this.enabled = env.callRecordingEnabled !== false;
        this.sessionId = options.sessionId || "";
        this.callId = options.callId || "";
        this.linkedid = options.linkedid || this.callId;
        this.tenant = options.tenant || null;
        this.agentId = options.agentId || null;
        this.mode = options.mode || "trunk";
        this.logger = options.logger || null;
        this.startedAt = new Date();
        this.closedAt = null;
        this.finalized = false;
        this.rawDir = path.join(env.tmpDir, "recordings");
        this.safeSessionId = safeName(this.sessionId || this.linkedid || `${Date.now()}`);
        this.sources = {
            customer: this.createSource("customer"),
            agent: this.createSource("agent"),
        };
        this.transcriptSegments = [];
    }

    createSource(source) {
        return {
            source,
            rawPath: path.join(this.rawDir, `${this.safeSessionId}-${source}.pcm`),
            stream: null,
            samplesWritten: 0,
            frames: 0,
            audioBytes: 0,
        };
    }

    recordCustomerPcm(pcmBuffer, options = {}) {
        this.recordPcm("customer", pcmBuffer, options);
    }

    recordAgentPcm(pcmBuffer, options = {}) {
        this.recordPcm("agent", pcmBuffer, options);
    }

    addTranscriptSegment(role, text, event = {}) {
        text = String(text || "").trim();

        if (!text) {
            return;
        }

        const side = ["assistant", "asistente", "agent", "agente"].includes(String(role || "").toLowerCase())
            ? "agent"
            : "customer";
        const channel = CHANNELS[side];

        this.transcriptSegments.push({
            speaker: channel.label,
            side: channel.side,
            text,
            event: event.type || null,
            event_id: event.event_id || null,
            at_ms: this.elapsedMs(),
        });
    }

    recordPcm(source, pcmBuffer, options = {}) {
        if (!this.enabled || this.finalized || !pcmBuffer || !pcmBuffer.length) {
            return;
        }

        if (!CHANNELS[source]) {
            return;
        }

        try {
            this.ensureSourceStream(source);
            const normalized = normalizePcm(pcmBuffer, {
                sampleRate: options.sampleRate || SAMPLE_RATE,
                channelCount: options.channelCount || 1,
            });

            if (!normalized.length) {
                return;
            }

            const state = this.sources[source];
            const targetSamples = Math.max(
                state.samplesWritten,
                Math.round((this.elapsedMs() * SAMPLE_RATE) / 1000)
            );
            const gapSamples = targetSamples - state.samplesWritten;

            if (gapSamples > 0) {
                writeSilence(state.stream, gapSamples);
                state.samplesWritten += gapSamples;
            }

            state.stream.write(normalized);
            state.samplesWritten += normalized.length / BYTES_PER_SAMPLE;
            state.frames += 1;
            state.audioBytes += normalized.length;
        } catch (error) {
            this.log("trunk call recording frame ignored", {
                source,
                error: error.message,
            });
        }
    }

    ensureSourceStream(source) {
        const state = this.sources[source];

        if (state.stream) {
            return;
        }

        fs.mkdirSync(this.rawDir, { recursive: true });
        state.stream = fs.createWriteStream(state.rawPath);
    }

    async finalize(reason = "closed") {
        if (!this.enabled || this.finalized) {
            return null;
        }

        this.finalized = true;
        this.closedAt = new Date();

        try {
            const result = await this.buildRecording(reason);

            if (result) {
                await this.sendRecordingCallback(result).catch((error) => {
                    this.log("trunk call recording callback failed", {
                        error: error.message,
                    });
                });
            }

            return result;
        } catch (error) {
            this.log("trunk call recording finalize failed", {
                error: error.message,
            });

            return null;
        }
    }

    async buildRecording(reason) {
        const sources = Object.values(this.sources);
        const maxSamples = Math.max(0, ...sources.map((source) => source.samplesWritten));

        if (maxSamples <= 0) {
            return null;
        }

        for (const source of sources) {
            this.ensureSourceStream(source.source);

            if (source.samplesWritten < maxSamples) {
                writeSilence(source.stream, maxSamples - source.samplesWritten);
                source.samplesWritten = maxSamples;
            }

            await closeStream(source.stream);
            source.stream = null;
        }

        fs.mkdirSync(env.recordingOutputDir, { recursive: true });

        const customerPcm = await fsp.readFile(this.sources.customer.rawPath);
        const agentPcm = await fsp.readFile(this.sources.agent.rawPath);
        const mixedPcm = mixMono(customerPcm, agentPcm);
        const filename = `recording-${this.safeSessionId}.wav`;
        const filePath = path.join(env.recordingOutputDir, filename);
        const wav = createWavBuffer(mixedPcm, {
            sampleRate: SAMPLE_RATE,
            channelCount: 1,
        });

        await fsp.writeFile(filePath, wav);

        const transcriptSegments = await this.resolveTranscriptSegments(customerPcm, agentPcm);
        const durationSeconds = Math.round(maxSamples / SAMPLE_RATE);

        await this.cleanupRawFiles();

        return {
            filePath,
            filename,
            audioUrl: this.buildAudioUrl(filename),
            mimeType: "audio/wav",
            sizeBytes: wav.length,
            durationSeconds,
            startedAt: this.startedAt.toISOString(),
            endedAt: this.closedAt.toISOString(),
            reason,
            transcriptSegments,
            transcript: transcriptSegments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n"),
            metadata: {
                mode: this.mode,
                sample_rate: SAMPLE_RATE,
                channels: {
                    mixed: [CHANNELS.customer.label, CHANNELS.agent.label],
                },
                playback_mix: "mono_centered",
                customer_frames: this.sources.customer.frames,
                agent_frames: this.sources.agent.frames,
            },
        };
    }

    async resolveTranscriptSegments(customerPcm, agentPcm) {
        const segments = [];

        if (env.callRecordingTranscribe) {
            segments.push(...await this.transcribeSource("customer", customerPcm));
            segments.push(...await this.transcribeSource("agent", agentPcm));
        }

        if (segments.length > 0) {
            return sortTranscriptSegments(segments);
        }

        return sortTranscriptSegments(this.transcriptSegments);
    }

    async transcribeSource(source, pcmBuffer) {
        const state = this.sources[source];

        if (!state || state.audioBytes <= 0 || !pcmBuffer.length) {
            return [];
        }

        const channel = CHANNELS[source];
        const speechSegments = detectSpeechSegments(pcmBuffer);
        const segments = speechSegments.length > 0
            ? speechSegments
            : [{
                startSample: 0,
                endSample: Math.floor(pcmBuffer.length / BYTES_PER_SAMPLE),
                startMs: 0,
                endMs: Math.round((state.samplesWritten / SAMPLE_RATE) * 1000),
            }];
        const transcriptSegments = [];

        for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index];
            const startByte = segment.startSample * BYTES_PER_SAMPLE;
            const endByte = segment.endSample * BYTES_PER_SAMPLE;
            const segmentPcm = pcmBuffer.subarray(startByte, endByte);

            if (!segmentPcm.length) {
                continue;
            }

            const filename = `recording-${this.safeSessionId}-${source}-${index + 1}.wav`;
            const filePath = path.join(this.rawDir, filename);
            const wav = createWavBuffer(segmentPcm, {
                sampleRate: SAMPLE_RATE,
                channelCount: 1,
            });

            await fsp.writeFile(filePath, wav);

            try {
                const result = await sttService.transcribe({
                    file: {
                        path: filePath,
                        originalname: filename,
                        mimetype: "audio/wav",
                        size: wav.length,
                    },
                    body: {
                        language: env.callAudioLanguage || "es",
                        prompt: `Transcribe solamente este fragmento de voz de ${channel.label}. No inventes texto si hay silencio.`,
                    },
                    cleanup: false,
                });
                const text = String(result.text || "").trim();

                if (text) {
                    transcriptSegments.push({
                        speaker: channel.label,
                        side: channel.side,
                        text,
                        start_ms: segment.startMs,
                        end_ms: segment.endMs,
                        provider: result.provider || null,
                        model: result.model || null,
                    });
                }
            } catch (error) {
                this.log("trunk call recording source segment transcription failed", {
                    source,
                    segment: index + 1,
                    error: error.message,
                });
            } finally {
                await fsp.unlink(filePath).catch(() => {});
            }
        }

        return transcriptSegments;
    }

    async sendRecordingCallback(result) {
        return laravelService.sendTrunkCallEvent({
            source: "ariana-asterisk-recording",
            event: "recording",
            linkedid: this.linkedid,
            external_call_id: this.linkedid,
            session_id: this.sessionId,
            call_id: this.linkedid,
            tenant: this.tenant,
            agent_id: this.agentId,
            recording: {
                audio_url: result.audioUrl,
                mime_type: result.mimeType,
                size_bytes: result.sizeBytes,
                duration_seconds: result.durationSeconds,
                started_at: result.startedAt,
                ended_at: result.endedAt,
                transcript: result.transcript,
                transcript_segments: result.transcriptSegments,
                metadata: result.metadata,
            },
        });
    }

    async cleanupRawFiles() {
        await Promise.all(
            Object.values(this.sources).map((source) => fsp.unlink(source.rawPath).catch(() => {}))
        );
    }

    buildAudioUrl(filename) {
        const relativeUrl = `/api/audio/${filename}`;

        if (!env.publicBaseUrl) {
            return relativeUrl;
        }

        return `${env.publicBaseUrl.replace(/\/$/, "")}${relativeUrl}`;
    }

    elapsedMs() {
        return Math.max(0, Date.now() - this.startedAt.getTime());
    }

    log(message, data = {}) {
        if (this.logger) {
            this.logger(message, data);
        }
    }
}

function normalizePcm(buffer, options = {}) {
    let pcm = Buffer.from(buffer);
    const channelCount = Math.max(1, Number(options.channelCount || 1));
    const sampleRate = Math.max(1, Number(options.sampleRate || SAMPLE_RATE));

    if (channelCount > 1) {
        pcm = downmixToMono(pcm, channelCount);
    }

    if (sampleRate !== SAMPLE_RATE) {
        pcm = resamplePcm16(pcm, sampleRate, SAMPLE_RATE);
    }

    return pcm;
}

function downmixToMono(buffer, channelCount) {
    const inputSamples = Math.floor(buffer.length / BYTES_PER_SAMPLE);
    const outputSamples = Math.floor(inputSamples / channelCount);
    const output = Buffer.alloc(outputSamples * BYTES_PER_SAMPLE);

    for (let frame = 0; frame < outputSamples; frame += 1) {
        let total = 0;

        for (let channel = 0; channel < channelCount; channel += 1) {
            total += buffer.readInt16LE((frame * channelCount + channel) * BYTES_PER_SAMPLE);
        }

        output.writeInt16LE(clampInt16(Math.round(total / channelCount)), frame * BYTES_PER_SAMPLE);
    }

    return output;
}

function resamplePcm16(buffer, fromRate, toRate) {
    if (!buffer.length || fromRate === toRate) {
        return buffer;
    }

    const inputSamples = Math.floor(buffer.length / BYTES_PER_SAMPLE);
    const outputSamples = Math.max(1, Math.round((inputSamples * toRate) / fromRate));
    const output = Buffer.alloc(outputSamples * BYTES_PER_SAMPLE);

    for (let index = 0; index < outputSamples; index += 1) {
        const sourceIndex = Math.min(
            inputSamples - 1,
            Math.floor((index * fromRate) / toRate)
        );

        output.writeInt16LE(buffer.readInt16LE(sourceIndex * BYTES_PER_SAMPLE), index * BYTES_PER_SAMPLE);
    }

    return output;
}

function mixMono(customerPcm, agentPcm) {
    const samples = Math.max(customerPcm.length, agentPcm.length) / BYTES_PER_SAMPLE;
    const output = Buffer.alloc(samples * BYTES_PER_SAMPLE);

    for (let index = 0; index < samples; index += 1) {
        const offset = index * BYTES_PER_SAMPLE;
        const customer = offset < customerPcm.length
            ? customerPcm.readInt16LE(offset)
            : 0;
        const agent = offset < agentPcm.length
            ? agentPcm.readInt16LE(offset)
            : 0;
        const mixed = customer !== 0 && agent !== 0
            ? Math.round((customer + agent) / 2)
            : customer + agent;

        output.writeInt16LE(clampInt16(mixed), offset);
    }

    return output;
}

function detectSpeechSegments(pcmBuffer) {
    const totalSamples = Math.floor(pcmBuffer.length / BYTES_PER_SAMPLE);
    const frameSamples = Math.max(1, Math.round((SAMPLE_RATE * TRANSCRIPTION_FRAME_MS) / 1000));
    const totalFrames = Math.ceil(totalSamples / frameSamples);

    if (totalFrames <= 0) {
        return [];
    }

    const levels = [];

    for (let frame = 0; frame < totalFrames; frame += 1) {
        const startSample = frame * frameSamples;
        const endSample = Math.min(totalSamples, startSample + frameSamples);

        levels.push(frameRms(pcmBuffer, startSample, endSample));
    }

    const audibleLevels = levels.filter((level) => level > 80);
    const threshold = audibleLevels.length > 0
        ? clampNumber(percentile(audibleLevels, 0.7) * 0.25, 280, 1400)
        : 280;
    const minSpeechFrames = Math.max(1, Math.ceil(TRANSCRIPTION_MIN_SPEECH_MS / TRANSCRIPTION_FRAME_MS));
    const silenceFrames = Math.max(1, Math.ceil(TRANSCRIPTION_END_SILENCE_MS / TRANSCRIPTION_FRAME_MS));
    const paddingFrames = Math.max(0, Math.ceil(TRANSCRIPTION_PADDING_MS / TRANSCRIPTION_FRAME_MS));
    const maxSegmentFrames = Math.max(1, Math.ceil(TRANSCRIPTION_MAX_SEGMENT_MS / TRANSCRIPTION_FRAME_MS));
    const segments = [];
    let activeStart = null;
    let lastSpeechFrame = null;
    let silentRun = 0;

    for (let frame = 0; frame < totalFrames; frame += 1) {
        const isSpeech = levels[frame] >= threshold;

        if (isSpeech) {
            if (activeStart === null) {
                activeStart = Math.max(0, frame - paddingFrames);
            }

            lastSpeechFrame = frame;
            silentRun = 0;
        } else if (activeStart !== null) {
            silentRun += 1;
        }

        const reachedSilence = activeStart !== null && silentRun >= silenceFrames;
        const reachedMaxLength = activeStart !== null && frame - activeStart >= maxSegmentFrames;
        const reachedEnd = activeStart !== null && frame === totalFrames - 1;

        if (reachedSilence || reachedMaxLength || reachedEnd) {
            const speechEndFrame = lastSpeechFrame !== null ? lastSpeechFrame + 1 : frame + 1;
            const endFrame = Math.min(totalFrames, speechEndFrame + paddingFrames);

            if (lastSpeechFrame !== null && lastSpeechFrame - activeStart + 1 >= minSpeechFrames) {
                segments.push(segmentFromFrames(activeStart, endFrame, frameSamples, totalSamples));
            }

            activeStart = null;
            lastSpeechFrame = null;
            silentRun = 0;
        }
    }

    return mergeCloseSegments(segments);
}

function segmentFromFrames(startFrame, endFrame, frameSamples, totalSamples) {
    const startSample = Math.min(totalSamples, startFrame * frameSamples);
    const endSample = Math.min(totalSamples, Math.max(startSample, endFrame * frameSamples));

    return {
        startSample,
        endSample,
        startMs: Math.round((startSample / SAMPLE_RATE) * 1000),
        endMs: Math.round((endSample / SAMPLE_RATE) * 1000),
    };
}

function mergeCloseSegments(segments) {
    const maxGapMs = 220;
    const merged = [];

    for (const segment of segments) {
        const previous = merged[merged.length - 1];

        if (previous && segment.startMs - previous.endMs <= maxGapMs) {
            previous.endSample = Math.max(previous.endSample, segment.endSample);
            previous.endMs = Math.max(previous.endMs, segment.endMs);
            continue;
        }

        merged.push({ ...segment });
    }

    return merged;
}

function frameRms(pcmBuffer, startSample, endSample) {
    let total = 0;
    let count = 0;

    for (let sample = startSample; sample < endSample; sample += 1) {
        const offset = sample * BYTES_PER_SAMPLE;

        if (offset + 1 >= pcmBuffer.length) {
            break;
        }

        const value = pcmBuffer.readInt16LE(offset);

        total += value * value;
        count += 1;
    }

    if (count <= 0) {
        return 0;
    }

    return Math.sqrt(total / count);
}

function percentile(values, ratio) {
    if (!values.length) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));

    return sorted[index];
}

function sortTranscriptSegments(segments) {
    return [...segments].sort((left, right) => {
        const leftTime = transcriptSegmentTime(left);
        const rightTime = transcriptSegmentTime(right);

        if (leftTime !== rightTime) {
            return leftTime - rightTime;
        }

        return sourceOrder(left.side) - sourceOrder(right.side);
    });
}

function transcriptSegmentTime(segment) {
    const value = segment.start_ms ?? segment.at_ms ?? segment.startMs ?? 0;
    const number = Number(value);

    return Number.isFinite(number) ? number : 0;
}

function sourceOrder(side) {
    return side === "customer" ? 0 : 1;
}

function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function writeSilence(stream, samples) {
    let remaining = Math.max(0, Math.floor(samples)) * BYTES_PER_SAMPLE;
    const chunk = Buffer.alloc(Math.min(remaining, SAMPLE_RATE * BYTES_PER_SAMPLE));

    while (remaining > 0) {
        const bytes = Math.min(remaining, chunk.length);
        stream.write(bytes === chunk.length ? chunk : Buffer.alloc(bytes));
        remaining -= bytes;
    }
}

function closeStream(stream) {
    return new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(resolve);
    });
}

function safeName(value) {
    return String(value || "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120) || `session-${Date.now()}`;
}

function clampInt16(value) {
    return Math.max(-32768, Math.min(32767, value));
}

module.exports = {
    CallRecording,
};
