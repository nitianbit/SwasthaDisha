"""Text sensitivities only; no JavaScript/TypeScript/compiler execution."""
from pathlib import Path
import hashlib
import json
import runpy

HERE = Path(__file__).resolve().parent
gate = runpy.run_path(str(HERE / "verify_source.py"), run_name="frozen_source_data_definitions")
text = (gate["ROOT"] / gate["SOURCE"]).read_text()
checks = gate["evaluate"](text)
assert all(checks.values()), "SOURCE_BASELINE_NOT_ACCEPTED"
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
variants = {}
for name, before in anchors.items():
    assert text.count(before) == 1, name
    variants[name] = text.replace(before, "/* source-data control removed anchor */", 1)
for name, marker in [("all_public_hashes", "const BROAD_LIBRARY_HASHES = Object.freeze("),
                     ("default_closure_hashes", "const BROAD_DEFAULT_LIBRARY_NAMES = Object.freeze(")]:
    start = text.index(marker) + len(marker)
    end = text.index(");", start)
    value = json.loads(text[start:end])
    if isinstance(value, dict): value["lib.d.ts"] = "0" * 64
    else: value.pop()
    variants[name] = text[:start] + json.dumps(value) + text[end:]
for name in ["positive", "negative"]:
    before = json.dumps(gate["PINS"][name]["text"])
    assert text.count(before) == 1
    variants[name + "_fixed_source"] = text.replace(before, json.dumps("export {};\n"), 1)
before = "      reportDiagnostics: true,"
assert text.count(before) == 1
variants["existing_compiler_restored_exactly"] = text.replace(before, "      reportDiagnostics: false,", 1)
assert set(variants) == set(checks)
rows = []
for name, variant in variants.items():
    result = gate["evaluate"](variant)
    rows.append({"id": name, "detected": result[name] is False,
                 "sourceSha256": hashlib.sha256(variant.encode()).hexdigest(),
                 "failedPredicates": [key for key, passed in result.items() if not passed]})
print(json.dumps({"schema": "SD-COMPILER-LIBRARY-TEXT-CONTROLS-1", "controls": rows,
                  "detected": sum(row["detected"] for row in rows), "total": len(rows),
                  "scope": "SOURCE_TEXT_ONLY_NOT_COMPILER_BEHAVIOR", "applicationEvaluations": 0,
                  "compilerExecutions": 0}, indent=2))
raise SystemExit(0 if all(row["detected"] for row in rows) else 1)
