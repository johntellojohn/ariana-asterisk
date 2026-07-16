function createWavBuffer(pcmBuffer, options = {}) {
    const sampleRate = options.sampleRate || 48000;
    const channelCount = options.channelCount || 1;
    const bitsPerSample = options.bitsPerSample || 16;
    const byteRate = sampleRate * channelCount * (bitsPerSample / 8);
    const blockAlign = channelCount * (bitsPerSample / 8);
    const header = Buffer.alloc(44);

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channelCount, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcmBuffer.length, 40);

    return Buffer.concat([header, pcmBuffer]);
}

function int16ArrayToBuffer(samples) {
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

module.exports = {
    createWavBuffer,
    int16ArrayToBuffer,
};
