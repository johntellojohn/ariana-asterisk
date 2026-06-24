const RTP_HEADER_LENGTH = 12;
const ULAW_SAMPLE_RATE = 8000;
const BROWSER_SAMPLE_RATE = 48000;
const PCM_RATIO_48_TO_8 = BROWSER_SAMPLE_RATE / ULAW_SAMPLE_RATE;
const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;

function parseRtpPacket(packet) {
    if (!Buffer.isBuffer(packet) || packet.length < RTP_HEADER_LENGTH) {
        return null;
    }

    const version = packet[0] >> 6;

    if (version !== 2) {
        return null;
    }

    const csrcCount = packet[0] & 0x0f;
    const hasExtension = Boolean(packet[0] & 0x10);
    let headerLength = RTP_HEADER_LENGTH + csrcCount * 4;

    if (packet.length < headerLength) {
        return null;
    }

    if (hasExtension) {
        if (packet.length < headerLength + 4) {
            return null;
        }

        const extensionWords = packet.readUInt16BE(headerLength + 2);
        headerLength += 4 + extensionWords * 4;
    }

    if (packet.length < headerLength) {
        return null;
    }

    return {
        payloadType: packet[1] & 0x7f,
        marker: Boolean(packet[1] & 0x80),
        sequence: packet.readUInt16BE(2),
        timestamp: packet.readUInt32BE(4),
        ssrc: packet.readUInt32BE(8),
        payload: packet.subarray(headerLength),
    };
}

function buildRtpPacket(payload, state, options = {}) {
    const header = Buffer.alloc(RTP_HEADER_LENGTH);
    const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);

    header[0] = 0x80;
    header[1] = Number(options.payloadType ?? 0) & 0x7f;
    header.writeUInt16BE(state.sequence & 0xffff, 2);
    header.writeUInt32BE(state.timestamp >>> 0, 4);
    header.writeUInt32BE(state.ssrc >>> 0, 8);

    state.sequence = (state.sequence + 1) & 0xffff;
    state.timestamp = (state.timestamp + payloadBuffer.length) >>> 0;

    return Buffer.concat([header, payloadBuffer]);
}

function decodeUlawPayloadToPcm48(payload) {
    const pcm8 = new Int16Array(payload.length);

    for (let index = 0; index < payload.length; index += 1) {
        pcm8[index] = decodeUlaw(payload[index]);
    }

    const pcm48 = new Int16Array(pcm8.length * PCM_RATIO_48_TO_8);

    for (let index = 0; index < pcm8.length; index += 1) {
        const sample = pcm8[index];
        const offset = index * PCM_RATIO_48_TO_8;

        for (let duplicate = 0; duplicate < PCM_RATIO_48_TO_8; duplicate += 1) {
            pcm48[offset + duplicate] = sample;
        }
    }

    return int16ToBufferLE(pcm48);
}

function pcm48BufferToUlawPayloads(buffer, state, frameSamples = 160) {
    const pcm48 = bufferToInt16LE(buffer);
    const pcm8 = downsample48To8(pcm48, state);
    const encoded = Buffer.alloc(pcm8.length);

    for (let index = 0; index < pcm8.length; index += 1) {
        encoded[index] = encodeUlaw(pcm8[index]);
    }

    state.ulawRemainder = state.ulawRemainder
        ? Buffer.concat([state.ulawRemainder, encoded])
        : encoded;

    const payloads = [];

    while (state.ulawRemainder.length >= frameSamples) {
        payloads.push(state.ulawRemainder.subarray(0, frameSamples));
        state.ulawRemainder = state.ulawRemainder.subarray(frameSamples);
    }

    return payloads;
}

function downsample48To8(samples, state) {
    const remainder = state.downsampleRemainder || new Int16Array(0);
    const combined = new Int16Array(remainder.length + samples.length);
    combined.set(remainder, 0);
    combined.set(samples, remainder.length);

    const completeLength = Math.floor(combined.length / PCM_RATIO_48_TO_8) * PCM_RATIO_48_TO_8;
    const output = new Int16Array(completeLength / PCM_RATIO_48_TO_8);

    for (let offset = 0, out = 0; offset < completeLength; offset += PCM_RATIO_48_TO_8, out += 1) {
        let sum = 0;

        for (let index = 0; index < PCM_RATIO_48_TO_8; index += 1) {
            sum += combined[offset + index];
        }

        output[out] = Math.max(-32768, Math.min(32767, Math.round(sum / PCM_RATIO_48_TO_8)));
    }

    state.downsampleRemainder = completeLength < combined.length
        ? new Int16Array(combined.subarray(completeLength))
        : new Int16Array(0);

    return output;
}

function bufferToInt16LE(buffer) {
    const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    const sampleCount = Math.floor(input.length / 2);
    const samples = new Int16Array(sampleCount);

    for (let index = 0; index < sampleCount; index += 1) {
        samples[index] = input.readInt16LE(index * 2);
    }

    return samples;
}

function int16ToBufferLE(samples) {
    const buffer = Buffer.alloc(samples.length * 2);

    for (let index = 0; index < samples.length; index += 1) {
        buffer.writeInt16LE(samples[index], index * 2);
    }

    return buffer;
}

function decodeUlaw(value) {
    value = (~value) & 0xff;

    let sample = ((value & 0x0f) << 3) + ULAW_BIAS;
    sample <<= (value & 0x70) >> 4;

    return (value & 0x80) ? ULAW_BIAS - sample : sample - ULAW_BIAS;
}

function encodeUlaw(sample) {
    let sign = (sample >> 8) & 0x80;

    if (sign !== 0) {
        sample = -sample;
    }

    sample = Math.min(sample, ULAW_CLIP) + ULAW_BIAS;

    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
        exponent -= 1;
    }

    const mantissa = (sample >> (exponent + 3)) & 0x0f;

    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

module.exports = {
    ULAW_SAMPLE_RATE,
    BROWSER_SAMPLE_RATE,
    parseRtpPacket,
    buildRtpPacket,
    decodeUlawPayloadToPcm48,
    pcm48BufferToUlawPayloads,
};
