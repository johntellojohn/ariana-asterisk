const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const ignoredDirs = new Set(["node_modules", ".git", "tmp", "logs"]);
const files = [];

function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ignoredDirs.has(entry.name)) {
            continue;
        }

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            walk(fullPath);
            continue;
        }

        if (entry.isFile() && entry.name.endsWith(".js")) {
            files.push(fullPath);
        }
    }
}

walk(rootDir);

for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
        stdio: "inherit",
    });

    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}
