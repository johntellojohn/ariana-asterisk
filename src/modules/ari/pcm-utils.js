function resamplePcm16(buffer, fromRate, toRate) {
    if (!buffer || !buffer.length || fromRate === toRate) {
        return buffer || Buffer.alloc(0);
    }

    const inputSamples = Math.floor(buffer.length / 2);

    if (inputSamples <= 0) {
        return Buffer.alloc(0);
    }

    const outputSamples = Math.max(1, Math.round((inputSamples * toRate) / fromRate));
    const output = Buffer.alloc(outputSamples * 2);

    for (let index = 0; index < outputSamples; index += 1) {
        const sourceIndex = Math.min(
            inputSamples - 1,
            Math.floor((index * fromRate) / toRate)
        );

        output.writeInt16LE(buffer.readInt16LE(sourceIndex * 2), index * 2);
    }

    return output;
}

module.exports = {
    resamplePcm16,
};
