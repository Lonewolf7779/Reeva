// scripts/run-tests.cjs — Isolated Test Suite Runner
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const testDir = path.resolve(__dirname, "../tests");
const testFiles = fs.readdirSync(testDir)
    .filter((f) => f.endsWith(".test.cjs"))
    .sort();

console.log(`Discovered ${testFiles.length} test files. Running suite with complete process isolation...`);

let totalPassed = 0;
for (const file of testFiles) {
    const filePath = path.join(testDir, file);
    console.log(`\n========================================\nRUNNING: ${file}\n========================================`);
    const start = Date.now();
    const result = spawnSync(process.execPath, [
        "--test",
        "--test-timeout=20000",
        "--test-force-exit",
        filePath
    ], {
        stdio: "inherit",
        env: {
            ...process.env,
            NODE_ENV: "test"
        }
    });

    const duration = ((Date.now() - start) / 1000).toFixed(2);
    if (result.status !== 0) {
        console.error(`\nFAILED: ${file} (exit code ${result.status}) in ${duration}s`);
        process.exit(result.status || 1);
    }
    console.log(`PASSED: ${file} in ${duration}s`);
    totalPassed++;
}

console.log(`\n========================================\nALL ${totalPassed}/${testFiles.length} TEST SUITES PASSED CLEANLY.\n========================================`);
