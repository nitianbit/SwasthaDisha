"""Frozen source-data gate. Never load TypeScript or execute fixture/app code."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
SOURCE = "test/api-runtime/scenario/compile.cjs"
BASE = "b33a9daac01628a48043e85764819a5f855431ed"
sha = lambda value: hashlib.sha256(value).hexdigest()
PINS = json.loads((ROOT / "output/qa/week2-compiler-library-admission/contract-inputs.json").read_text())
BASELINE = subprocess.run(["git", "show", BASE + ":" + SOURCE], cwd=ROOT, check=True,
                          stdout=subprocess.PIPE).stdout.decode()


def predicates(text):
    anchors = {
        "correct_library_location": "host.getDefaultLibLocation = () => libraryRoot;",
        "capture_inherited_location": "const inheritedGetDefaultLibLocation = host.getDefaultLibLocation;",
        "same_guarded_read": "host.readFile = file => allowedTypeFile(file) ? libraryAdmission.read(file, readFile) : undefined;",
        "same_host_probe": "const probeHost = { ...host,",
        "exact_default_closure": "JSON.stringify(row.programFiles) === JSON.stringify([...libraryIds, sourceId].sort())",
        "positive_zero": "row.diagnostics.length === 0 && sameLibraries(row)",
        "negative_exact_one": "negative.diagnostics.length === 1",
        "negative_exact_code": "diagnostic.code === 2322 && diagnostic.category === 1",
        "negative_exact_span": "diagnostic.start === 13 && diagnostic.length === 12",
        "old_same_predicate": "!positivePredicate(report.oldHostControl)",
        "old_array_required": "diagnostic.code === 2318 && diagnostic.message === \"Cannot find global type 'Array'.\"",
        "old_incomplete": "!sameLibraries(report.oldHostControl)",
        "old_exception_not_detection": "report.oldHostControl.status === 'COMPLETE'",
        "old_restore": "finally { host.getDefaultLibLocation = correctedLocation; }",
        "restored_positive": "positivePredicate(report.restoredPositive)",
        "hash_guard": "requireThat(sha(data) === BROAD_LIBRARY_HASHES[name], 'BROAD_LIBRARY_INPUT_HASH');",
        "actual_used_hashes": "used[name] = BROAD_LIBRARY_HASHES[name];",
        "fixed_failure": "throw new Error('BROAD_LIBRARY_ADMISSION_FAILED');",
        "new_report": "selectedHelperTypecheck: indexTypecheck, libraryAdmission: broadLibraryReport",
    }
    results = {name: anchor in text for name, anchor in anchors.items()}
    for name, key in [("all_public_hashes", "allPublicStandardLibraries"), ("default_closure_hashes", "standardLibraries")]:
        marker = "const BROAD_LIBRARY_HASHES = Object.freeze(" if key == "allPublicStandardLibraries" else "const BROAD_DEFAULT_LIBRARY_NAMES = Object.freeze("
        try:
            raw = text.split(marker, 1)[1].split(");", 1)[0]
            actual = json.loads(raw)
            results[name] = actual == PINS[key] if key == "allPublicStandardLibraries" else actual == sorted(PINS[key])
        except (IndexError, ValueError):
            results[name] = False
    for name in ["positive", "negative"]:
        results[name + "_fixed_source"] = json.dumps(PINS[name]["text"]) in text
    return results


def preserved(text):
    try:
        start = text.index("// Frozen broad standard-library admission.")
        end = text.index("function assertModelDeclarations", start)
        restored = text[:start] + text[end:]
        added = "  const libraryRoot = path.join(typeRoot, 'typescript/lib');\n  const inheritedGetDefaultLibLocation = host.getDefaultLibLocation;\n  const libraryAdmission = createBroadLibraryAdmission(sourceRoot, runtimeRoot, options);\n"
        assert restored.count(added) == 1
        restored = restored.replace(added, "", 1)
        restored = restored.replace("host.readFile = file => allowedTypeFile(file) ? libraryAdmission.read(file, readFile) : undefined;",
                                    "host.readFile = file => allowedTypeFile(file) ? readFile(file) : undefined;", 1)
        restored = restored.replace("  host.getDefaultLibLocation = () => libraryRoot;\n", "", 1)
        restored = restored.replace("const program = libraryAdmission.createProgram(() => ts.createProgram([...sourcePaths], options, host));",
                                    "const program = ts.createProgram([...sourcePaths], options, host);", 1)
        restored = restored.replace("const semanticDiagnostics = libraryAdmission.getDiagnostics(() => ts.getPreEmitDiagnostics(program)).map(item => ({",
                                    "const semanticDiagnostics = ts.getPreEmitDiagnostics(program).map(item => ({", 1)
        restored = restored.replace("  const broadLibraryReport = libraryAdmission.check(host, inheritedGetDefaultLibLocation);\n", "", 1)
        restored = restored.replace("selectedHelperTypecheck: indexTypecheck, libraryAdmission: broadLibraryReport", "selectedHelperTypecheck: indexTypecheck", 1)
        return restored == BASELINE
    except (ValueError, AssertionError):
        return False


def evaluate(text):
    checks = predicates(text)
    checks["existing_compiler_restored_exactly"] = preserved(text)
    return checks


if __name__ == "__main__":
    text = (ROOT / SOURCE).read_text()
    checks = evaluate(text)
    print(json.dumps({"schema": "SD-COMPILER-LIBRARY-SOURCE-DATA-1", "baseline": BASE,
                      "sourceSha256": sha(text.encode()), "checks": checks,
                      "passed": sum(checks.values()), "total": len(checks),
                      "applicationEvaluations": 0, "compilerExecutions": 0}, indent=2))
    raise SystemExit(0 if all(checks.values()) else 1)
