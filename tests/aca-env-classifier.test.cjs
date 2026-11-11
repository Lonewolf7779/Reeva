// tests/aca-env-classifier.test.cjs — Regression Tests for Authoritative ACA Environment Classification
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEPLOY_SCRIPT_PATH = path.resolve(__dirname, "../scripts/deploy-aca.sh");

function resolvePythonExecutable() {
    for (const candidate of ["python3", "python"]) {
        const probe = spawnSync(candidate, ["-c", "import sys; assert sys.version_info[0] >= 3"], {
            encoding: "utf8",
            timeout: 5000
        });
        if (!probe.error && probe.status === 0) {
            return candidate;
        }
    }
    throw new Error("Python 3 executable is required to run ACA environment classifier tests.");
}

const PYTHON_BIN = resolvePythonExecutable();

function extractClassifierModuleSource() {
    const scriptContent = fs.readFileSync(DEPLOY_SCRIPT_PATH, "utf8");
    const beginMarker = "# BEGIN_ACA_ENV_CLASSIFIER";
    const endMarker = "# END_ACA_ENV_CLASSIFIER";
    const startIdx = scriptContent.indexOf(beginMarker);
    const endIdx = scriptContent.indexOf(endMarker);

    assert.ok(startIdx !== -1, "scripts/deploy-aca.sh must contain # BEGIN_ACA_ENV_CLASSIFIER");
    assert.ok(endIdx !== -1 && endIdx > startIdx, "scripts/deploy-aca.sh must contain # END_ACA_ENV_CLASSIFIER");

    return scriptContent.slice(startIdx, endIdx + endMarker.length);
}

const CLASSIFIER_SOURCE = extractClassifierModuleSource();

function invokeClassifier(payload) {
    const runnerCode = `
${CLASSIFIER_SOURCE}

data = json.loads(sys.stdin.read())
action = data.get("action", "classify")
if action == "classify":
    res = classify_aca_environment(
        data.get("cli_env"),
        authoritative_arm_env=data.get("authoritative_arm_env"),
        expected_location=data.get("expected_location"),
        require_succeeded=bool(data.get("require_succeeded", False)),
        require_authoritative=bool(data.get("require_authoritative", False))
    )
    print(json.dumps(res))
elif action == "validate_args":
    res = validate_env_creation_args(
        data.get("args_list"),
        supports_environment_mode_flag=bool(data.get("supports_environment_mode_flag", False)),
        target_env_name=data.get("target_env_name", "reeva-standard-env"),
        legacy_env_name=data.get("legacy_env_name", "reeva-env"),
        expected_location=data.get("expected_location", "centralindia")
    )
    print(json.dumps(res))
else:
    raise ValueError(f"Unknown action: {action}")
`;

    const result = spawnSync(PYTHON_BIN, ["-c", runnerCode], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10000
    });

    assert.equal(result.status, 0, `Python classifier exited with ${result.status}: ${result.stderr}`);
    return JSON.parse(result.stdout.trim());
}

test("Fixture A: Express + Consumption profile = REJECT (exact live ARM 2026-07-01 payload & lowercase variant)", () => {
    // Exact live Azure ARM response from api-version=2026-07-01
    const liveExpressPayload = {
        environmentMode: "Express",
        workloadProfiles: [
            {
                name: "Consumption",
                workloadProfileType: "Consumption"
            }
        ]
    };

    const resExact = invokeClassifier({
        cli_env: liveExpressPayload,
        authoritative_arm_env: liveExpressPayload
    });
    assert.equal(resExact.decision, "REJECT");
    assert.equal(resExact.compatible, false);
    assert.equal(resExact.reason, "EXPRESS_ENVIRONMENT");
    assert.equal(resExact.has_consumption_profile, true);

    // Lowercase "express" variant inside full ARM properties envelope
    const lowercaseExpressEnvelope = {
        id: "/subscriptions/sub-1/resourceGroups/reeva-rg/providers/Microsoft.App/managedEnvironments/reeva-env",
        name: "reeva-env",
        location: "Central India",
        properties: {
            provisioningState: "Succeeded",
            environmentMode: "express",
            workloadProfiles: [
                {
                    name: "Consumption",
                    workloadProfileType: "Consumption"
                }
            ]
        }
    };

    const resLower = invokeClassifier({
        cli_env: lowercaseExpressEnvelope,
        authoritative_arm_env: lowercaseExpressEnvelope,
        expected_location: "centralindia",
        require_succeeded: true,
        require_authoritative: true
    });
    assert.equal(resLower.decision, "REJECT");
    assert.equal(resLower.compatible, false);
    assert.equal(resLower.reason, "EXPRESS_ENVIRONMENT");
});

test("Fixture B: Standard WorkloadProfiles + Consumption profile = ACCEPT", () => {
    const standardEnvelope = {
        id: "/subscriptions/sub-1/resourceGroups/reeva-rg/providers/Microsoft.App/managedEnvironments/reeva-standard-env",
        name: "reeva-standard-env",
        location: "Central India",
        properties: {
            provisioningState: "Succeeded",
            environmentMode: "WorkloadProfiles",
            workloadProfiles: [
                {
                    name: "Consumption",
                    workloadProfileType: "Consumption"
                }
            ]
        }
    };

    const res = invokeClassifier({
        cli_env: standardEnvelope,
        authoritative_arm_env: standardEnvelope,
        expected_location: "centralindia",
        require_succeeded: true,
        require_authoritative: true
    });
    assert.equal(res.decision, "ACCEPT");
    assert.equal(res.compatible, true);
    assert.equal(res.reason, "STANDARD_WORKLOAD_PROFILES");
    assert.equal(res.environment_mode, "WorkloadProfiles");
    assert.equal(res.has_consumption_profile, true);

    // Also verify standard WorkloadProfiles without Consumption profile is rejected
    const dedicatedOnlyEnvelope = {
        id: "/subscriptions/sub-1/resourceGroups/reeva-rg/providers/Microsoft.App/managedEnvironments/reeva-standard-env",
        name: "reeva-standard-env",
        location: "Central India",
        properties: {
            provisioningState: "Succeeded",
            environmentMode: "WorkloadProfiles",
            workloadProfiles: [
                {
                    name: "Dedicated-D4",
                    workloadProfileType: "D4"
                }
            ]
        }
    };

    const resNoConsumption = invokeClassifier({
        cli_env: dedicatedOnlyEnvelope,
        authoritative_arm_env: dedicatedOnlyEnvelope,
        expected_location: "centralindia",
        require_succeeded: true,
        require_authoritative: true
    });
    assert.equal(resNoConsumption.decision, "REJECT");
    assert.equal(resNoConsumption.reason, "MISSING_CONSUMPTION_WORKLOAD_PROFILE");
});

test("Fixture C: Missing environmentMode + Consumption profile = REJECT unless authoritative metadata resolves it", () => {
    // Older Azure CLI response (e.g., 2025-10-02-preview) where environmentMode is omitted/null
    const cliEnvMissingMode = {
        id: "/subscriptions/sub-1/resourceGroups/reeva-rg/providers/Microsoft.App/managedEnvironments/reeva-env",
        name: "reeva-env",
        location: "Central India",
        properties: {
            provisioningState: "Succeeded",
            environmentMode: null,
            workloadProfiles: [
                {
                    name: "Consumption",
                    workloadProfileType: "Consumption"
                }
            ]
        }
    };

    // Case C1: No authoritative metadata provided -> must fail closed (REJECT)
    const resWithoutAuth = invokeClassifier({
        cli_env: cliEnvMissingMode,
        authoritative_arm_env: null
    });
    assert.equal(resWithoutAuth.decision, "REJECT");
    assert.equal(resWithoutAuth.compatible, false);
    assert.equal(resWithoutAuth.reason, "MISSING_OR_AMBIGUOUS_ENVIRONMENT_MODE");

    // Case C2: Authoritative metadata also lacks environmentMode (ambiguous) -> must fail closed (REJECT)
    const resAmbiguousAuth = invokeClassifier({
        cli_env: cliEnvMissingMode,
        authoritative_arm_env: {
            id: cliEnvMissingMode.id,
            name: "reeva-env",
            location: "Central India",
            properties: {
                provisioningState: "Succeeded",
                workloadProfiles: [
                    {
                        name: "Consumption",
                        workloadProfileType: "Consumption"
                    }
                ]
            }
        },
        expected_location: "centralindia",
        require_succeeded: true,
        require_authoritative: true
    });
    assert.equal(resAmbiguousAuth.decision, "REJECT");
    assert.equal(resAmbiguousAuth.compatible, false);
    assert.equal(resAmbiguousAuth.reason, "MISSING_OR_AMBIGUOUS_ENVIRONMENT_MODE");

    // Case C3: Authoritative metadata (2026-07-01) resolves missing CLI environmentMode to Express -> REJECT
    const resResolvedExpress = invokeClassifier({
        cli_env: cliEnvMissingMode,
        authoritative_arm_env: {
            id: cliEnvMissingMode.id,
            name: "reeva-env",
            location: "Central India",
            properties: {
                provisioningState: "Succeeded",
                environmentMode: "Express",
                workloadProfiles: [
                    {
                        name: "Consumption",
                        workloadProfileType: "Consumption"
                    }
                ]
            }
        },
        expected_location: "centralindia",
        require_succeeded: true,
        require_authoritative: true
    });
    assert.equal(resResolvedExpress.decision, "REJECT");
    assert.equal(resResolvedExpress.compatible, false);
    assert.equal(resResolvedExpress.reason, "EXPRESS_ENVIRONMENT");

    // Case C4: Authoritative metadata (2026-07-01) explicitly resolves missing CLI environmentMode to WorkloadProfiles -> ACCEPT
    const resResolvedStandard = invokeClassifier({
        cli_env: cliEnvMissingMode,
        authoritative_arm_env: {
            id: "/subscriptions/sub-1/resourceGroups/reeva-rg/providers/Microsoft.App/managedEnvironments/reeva-standard-env",
            name: "reeva-standard-env",
            location: "Central India",
            properties: {
                provisioningState: "Succeeded",
                environmentMode: "WorkloadProfiles",
                workloadProfiles: [
                    {
                        name: "Consumption",
                        workloadProfileType: "Consumption"
                    }
                ]
            }
        },
        expected_location: "centralindia",
        require_succeeded: true,
        require_authoritative: true
    });
    assert.equal(resResolvedStandard.decision, "ACCEPT");
    assert.equal(resResolvedStandard.compatible, true);
    assert.equal(resResolvedStandard.reason, "STANDARD_WORKLOAD_PROFILES");
});

test("Fixture D: Express metadata must NEVER be overridden by workloadProfiles or conflicting fields", () => {
    // Case D1: CLI claims Express while authoritative payload has Consumption profile
    const resCliExpress = invokeClassifier({
        cli_env: {
            name: "reeva-env",
            location: "Central India",
            properties: {
                provisioningState: "Succeeded",
                environmentMode: "Express",
                workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }]
            }
        },
        authoritative_arm_env: {
            name: "reeva-env",
            location: "Central India",
            properties: {
                provisioningState: "Succeeded",
                environmentMode: "WorkloadProfiles",
                workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }]
            }
        }
    });
    assert.equal(resCliExpress.decision, "REJECT");
    assert.equal(resCliExpress.reason, "EXPRESS_ENVIRONMENT");

    // Case D2: kind contains 'express' even if environmentMode says WorkloadProfiles and Consumption profile exists
    const resKindExpress = invokeClassifier({
        cli_env: {
            name: "reeva-env",
            kind: "managedenvironment,express",
            location: "Central India",
            properties: {
                provisioningState: "Succeeded",
                environmentMode: "WorkloadProfiles",
                workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }]
            }
        },
        authoritative_arm_env: {
            name: "reeva-env",
            kind: "managedenvironment,express",
            location: "Central India",
            properties: {
                provisioningState: "Succeeded",
                environmentMode: "WorkloadProfiles",
                workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }]
            }
        }
    });
    assert.equal(resKindExpress.decision, "REJECT");
    assert.equal(resKindExpress.reason, "EXPRESS_ENVIRONMENT");

    // Case D3: planType is Express even if environmentMode says WorkloadProfiles and Consumption profile exists
    const resPlanExpress = invokeClassifier({
        cli_env: {
            name: "reeva-env",
            location: "Central India",
            properties: {
                provisioningState: "Succeeded",
                environmentMode: "WorkloadProfiles",
                planType: "Express",
                workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }]
            }
        }
    });
    assert.equal(resPlanExpress.decision, "REJECT");
    assert.equal(resPlanExpress.reason, "EXPRESS_ENVIRONMENT");
});

test("Environment Creation Config Validator: Enforces preview 1.3.0b5 --environment-mode WorkloadProfiles and --enable-workload-profiles", () => {
    // Valid args when extension 1.3.0b5 supports --environment-mode
    const validPreview = invokeClassifier({
        action: "validate_args",
        supports_environment_mode_flag: true,
        args_list: [
            "--name", "reeva-standard-env",
            "--resource-group", "reeva-rg",
            "--location", "centralindia",
            "--enable-workload-profiles",
            "--environment-mode", "WorkloadProfiles"
        ]
    });
    assert.equal(validPreview.valid, true);

    // Reject if extension supports --environment-mode but flag is omitted
    const missingEnvModeOnPreview = invokeClassifier({
        action: "validate_args",
        supports_environment_mode_flag: true,
        args_list: [
            "--name", "reeva-standard-env",
            "--resource-group", "reeva-rg",
            "--location", "centralindia",
            "--enable-workload-profiles"
        ]
    });
    assert.equal(missingEnvModeOnPreview.valid, false);

    // Reject if --environment-mode is Express
    const expressModeArg = invokeClassifier({
        action: "validate_args",
        supports_environment_mode_flag: true,
        args_list: [
            "--name", "reeva-standard-env",
            "--resource-group", "reeva-rg",
            "--location", "centralindia",
            "--enable-workload-profiles",
            "--environment-mode", "express"
        ]
    });
    assert.equal(expressModeArg.valid, false);

    // Reject if target name collides with preserved reeva-env
    const legacyNameCollision = invokeClassifier({
        action: "validate_args",
        supports_environment_mode_flag: true,
        args_list: [
            "--name", "reeva-env",
            "--resource-group", "reeva-rg",
            "--location", "centralindia",
            "--enable-workload-profiles",
            "--environment-mode", "WorkloadProfiles"
        ]
    });
    assert.equal(legacyNameCollision.valid, false);
});

test("Static Deployment Script Verification: Uses az rest with api-version=2026-07-01 and preserves all security gates", () => {
    const scriptContent = fs.readFileSync(DEPLOY_SCRIPT_PATH, "utf8");

    assert.match(
        scriptContent,
        /ARM_ENV_API_VERSION="2026-07-01"/,
        "deploy-aca.sh must define ARM_ENV_API_VERSION=\"2026-07-01\""
    );
    assert.match(
        scriptContent,
        /az rest --method get[\s\\]+--url "https:\/\/management\.azure\.com\$\{env_resource_id\}\?api-version=\$\{ARM_ENV_API_VERSION\}"/,
        "deploy-aca.sh must query authoritative ARM metadata using az rest --method get with api-version=2026-07-01"
    );
    assert.ok(!scriptContent.includes("az containerapp delete"), "Must never delete container apps");
    assert.ok(!scriptContent.includes("az containerapp env delete"), "Must never delete container app environments");
    assert.ok(!scriptContent.includes("admin-enabled"), "Must never enable ACR admin credentials");
});
