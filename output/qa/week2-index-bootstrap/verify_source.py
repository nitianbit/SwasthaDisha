"""Source-data/preservation checks only. Never parse or evaluate TypeScript."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASE = "4275053"
BOOT = "test/api-runtime/scenario/bootstrap.cjs"
UNIT = "test/api-runtime/scenario/bootstrap-unit.cjs"
sha = lambda value: hashlib.sha256(value).hexdigest()


def git(*args, cwd=ROOT):
    return subprocess.run(["git", *args], cwd=cwd, check=True, stdout=subprocess.PIPE).stdout


def check():
    baseline = git("show", BASE + ":" + BOOT).decode()
    current = (ROOT / BOOT).read_text()
    restored = current
    begin = restored.index("const INDEX_FAILURE_CODES =")
    end = restored.index("const MODEL_IDENTITIES =", begin)
    restored = restored[:begin] + restored[end:]
    for name, count in [("ADMITTED_ROOTS", 9), ("REQUIRED_CASE_IDS", 76), ("REQUIRED_SENSITIVITY_IDS", 21)]:
        pattern = r"const " + name + r" = Object.freeze\(\[.*?\n\]\);"
        old = re.search(pattern, baseline, re.S).group()
        new = re.search(pattern, restored, re.S).group()
        old_ids = re.findall(r'"([^"\n]+)"', old)
        new_ids = re.findall(r'"([^"\n]+)"', new)
        assert len(old_ids) == count and new_ids[:count] == old_ids, name
        restored = restored.replace(new, old, 1)
    begin = restored.index("    indexScope(attempts) {")
    end = restored.index("    load: name => require(name),", begin)
    restored = restored[:begin] + restored[end:]
    begin = restored.index("  need(plan.modules[INDEX_ALIAS]")
    end = restored.index("  need(Array.isArray(ports.models)", begin)
    restored = restored[:begin] + restored[end:]
    begin = restored.index("// All index fixture helpers below are orchestration.")
    end = restored.index("async function main() {", begin)
    restored = restored[:begin] + restored[end:]
    added_call = "    const indexEvidence = await collectIndexEvidence({ manifest, ports, plan, mongoose, loader, effects: counters,\n      readOps, writeOps, network: net, jwt, axios, substitutes: currentPorts.substitutes });\n"
    assert restored.count(added_call) == 1
    restored = restored.replace(added_call, "", 1)
    restored = restored.replace("load: loader.load, configurationEvidence, indexEvidence,", "load: loader.load, configurationEvidence,", 1)
    added_exports = ",\n  indexLongWords, indexScalar, projectIndexRow, indexManifest, collectIndexObservations, withIndexTaps, validateIndexTypeReport, createIndexCommandPort,\n  INDEX_SOURCE_SHA, INDEX_MUTANTS"
    assert restored.count(added_exports) == 1
    restored = restored.replace(added_exports, "", 1)
    assert restored == baseline, "EXISTING_BOOTSTRAP_BODY_CHANGED"

    old_unit = git("show", BASE + ":" + UNIT).decode()
    new_unit = (ROOT / UNIT).read_text()
    for start, stop in [("function fakeConfigurationRuntime()", "function recordingCheck("),
                        ("function recordingUnits()", "class FakeIndexLong")]:
        old_end = old_unit.index("async function setupUnits()") if stop == "class FakeIndexLong" else old_unit.index(stop)
        new_end = new_unit.index(stop)
        assert old_unit[old_unit.index(start):old_end] == new_unit[new_unit.index(start):new_end], start

    pins = json.loads((ROOT / "output/qa/week2-index-readiness-runtime/pin-intents.json").read_text())
    helper = (ROOT / "src1/modules/common/utils/indexReadiness.ts").read_bytes()
    assert sha(helper) == "050ecc993c862638cf4912bb854e04baa5d80241cb124e7831fc3c95a78db5bd"
    trial_block = current[current.index("const INDEX_TRIALS"):current.index("const MODEL_IDENTITIES")]
    actual = re.findall(r'Object.freeze\((\[.*\])\)', trial_block)
    expected = [[row["id"], row["group"], row["expected"], row["repetitions"]] for row in pins["trials"]]
    assert [json.loads(row) for row in actual] == expected and len(expected) == 172
    assert sum(2 if row[3] == "BOTH" else 1 for row in expected) == 343
    assert sum(len(row["trialIds"]) for row in pins["sourceMutations"]) == 75
    for row in pins["sourceMutations"]:
        assert helper.decode().count(row["before"]) == 1
        assert sha(helper.decode().replace(row["before"], row["after"]).encode()) == row["predictedTransformedSourceSha"]
    fragment = ROOT / "output/qa/week2-index-bootstrap-matrix/run-index-matrix.fragment.txt"
    assert sha(fragment.read_bytes()) == "12dc2dbaf178478842b2203d4f2afb9b40c7c3b0c055a69c45111a22c25be143"
    assert current.count(fragment.read_text()) == 1
    assert sha((ROOT / "test/api-runtime/scenario/ports-manifest.json").read_bytes()) == "08583e74231bb02151ae2c89537233b198e1241ac769d65c874ee5aa8f06b33b"
    archive = ROOT / "output/qa/week2-index-bootstrap/revision-1"
    archived = json.loads((archive / "archive-manifest.json").read_text())
    assert len(archived["files"]) == 16
    for name, digest in archived["files"].items():
        assert sha((archive / name).read_bytes()) == digest

    original = Path("/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha")
    preservation = json.loads((ROOT / "output/qa/m0-b/otp-containment-2026-11-10/source-verification.json").read_text())
    assert sha(git("diff", "--cached", "--binary", "--full-index", cwd=original)) == "00b2ad0daae9ac54adda82e8a7eb1450ca25340be4412ac76f226bfd6c45ff9a"
    staged = git("diff", "--cached", "--name-only", cwd=original).decode().splitlines()
    assert len(staged) == 6
    for name in staged:
        assert (original / name).read_bytes() == git("show", ":" + name, cwd=original)
    for name, digest in preservation["preserved_handover_sha256"].items():
        assert sha((original / name).read_bytes()) == digest
    return {"schema": "SD-INDEX-BOOTSTRAP-SOURCE-DATA-1", "status": "PASS_SOURCE_DATA_ONLY",
            "baseline": BASE, "oldBootstrapRestoredExactly": True,
            "oldConfigurationRecordingMeetUnitsExact": True, "trialDefinitions": 172,
            "plannedNominalComparisons": 343, "plannedSensitivityReferences": 75,
            "exactSourceTransforms": 6, "matrixFragmentVerbatim": True,
            "preservedPriorCandidateFiles": 16,
            "originalStaged": 6, "originalHandover": 11,
            "applicationEvaluations": 0, "compilerExecutions": 0, "databaseCommands": 0,
            "files": {name: sha((ROOT / name).read_bytes()) for name in [BOOT, UNIT, "test/api-runtime/scenario/ports-manifest.json"]}}


if __name__ == "__main__":
    print(json.dumps(check(), indent=2))
