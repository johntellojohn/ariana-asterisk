const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const env = require("../../config/env");

const MIME_TYPES = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    m4a: "audio/x-m4a",
    ogg: "audio/ogg",
    webm: "audio/webm",
};

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function getAudioPath(filename) {
    if (!filename || filename !== path.basename(filename)) {
        throw httpError(400, "Invalid audio filename");
    }

    const resolvedOutputDir = path.resolve(env.recordingOutputDir);
    const resolvedAudioPath = path.resolve(resolvedOutputDir, filename);

    if (!resolvedAudioPath.startsWith(`${resolvedOutputDir}${path.sep}`)) {
        throw httpError(400, "Invalid audio path");
    }

    return resolvedAudioPath;
}

function mimeType(filename) {
    const extension = path.extname(filename).replace(".", "").toLowerCase();

    return MIME_TYPES[extension] || "application/octet-stream";
}

function setHeaders(res, filename, type) {
    res.removeHeader("Content-Security-Policy");
    res.removeHeader("Strict-Transport-Security");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function streamAudio(req, res, next) {
    try {
        const filename = req.params.filename;
        const audioPath = getAudioPath(filename);
        const stat = await fsp.stat(audioPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        setHeaders(res, filename, mimeType(filename));

        if (!range) {
            res.status(200);
            res.setHeader("Content-Length", fileSize);

            if (req.method === "HEAD") {
                return res.end();
            }

            return fs.createReadStream(audioPath).pipe(res);
        }

        const matches = range.match(/^bytes=(\d*)-(\d*)$/);

        if (!matches) {
            res.status(416);
            res.setHeader("Content-Range", `bytes */${fileSize}`);
            return res.end();
        }

        const start = matches[1] ? Number(matches[1]) : 0;
        const end = matches[2] ? Number(matches[2]) : fileSize - 1;

        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= fileSize) {
            res.status(416);
            res.setHeader("Content-Range", `bytes */${fileSize}`);
            return res.end();
        }

        const safeEnd = Math.min(end, fileSize - 1);
        const chunkSize = safeEnd - start + 1;

        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${safeEnd}/${fileSize}`);
        res.setHeader("Content-Length", chunkSize);

        if (req.method === "HEAD") {
            return res.end();
        }

        return fs.createReadStream(audioPath, { start, end: safeEnd }).pipe(res);
    } catch (error) {
        if (error.code === "ENOENT") {
            error.status = 404;
            error.message = "Audio file not found";
        }

        return next(error);
    }
}

module.exports = {
    streamAudio,
};
