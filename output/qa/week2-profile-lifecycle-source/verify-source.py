#!/usr/bin/env python3
"""Source bytes/JSON/Git only; no application/TypeDI/JS/TS parser or execution."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[3]
BASE = '7eb4a6b3753917925d799b096f0a54dfbe1d8154'
QA = 'output/qa/week2-profile-lifecycle-source/'
BOOT = 'test/api-runtime/scenario/bootstrap.cjs'
UNIT = 'test/api-runtime/scenario/bootstrap-unit.cjs'
OWNED = {BOOT, UNIT}
sha = lambda data: hashlib.sha256(data).hexdigest()
source = (ROOT / BOOT).read_text()
unit = (ROOT / UNIT).read_text()
baseline = subprocess.check_output(['git', 'show', BASE + ':' + BOOT], cwd=ROOT).decode()
old_unit = subprocess.check_output(['git', 'show', BASE + ':' + UNIT], cwd=ROOT).decode()
window = """    withContainerReset(reset) {
      need(typeof reset === 'function', 'SPECIALIST_PROFILE_RESET_CALLBACK');
      need(!containerResetWindow, 'SPECIALIST_PROFILE_RESET_REENTRANT');
      containerResetWindow = true;
      try { reset(); } finally { containerResetWindow = false; }
    },
"""
old_get = "              // TypeDI's constructor/prototype metadata is the only inert instance access.\n"
new_get = "              // Only the owned synchronous reset may probe this absent lifecycle hook.\n              if (containerResetWindow && key === 'destroy') return undefined;\n"
forward = '    withProfileContainerReset: reset => profile.withContainerReset(reset),\n'
wrapped = "    loader.withProfileContainerReset(() => typedi.Container.of().reset({ strategy: 'resetServices' }));"
original_call = "    typedi.Container.of().reset({ strategy: 'resetServices' });"
reversed_source = source.replace('  let registered; let containerResetWindow = false;\n', '  let registered;\n', 1).replace(window, '', 1).replace(new_get, old_get, 1).replace(forward, '', 1).replace(wrapped, original_call, 1)
start = unit.find('  // Lifecycle contract: actual fixture factory/classes, handwritten fake reset\n')
end = unit.find("  need(applicationImports === 0 && connections === 0 && domainWrites === 0 && nativeChildLoads === 0, 'PROFILE_OFFLINE_EFFECTS');", start)
reversed_unit = unit[:start] + unit[end:] if 0 <= start < end else None
phase_start = source.find('  function phase(overrides = {}) {')
phase_end = source.find('  const endPhase', phase_start)
phase = source[phase_start:phase_end] if 0 <= phase_start < phase_end else ''
positions = [phase.find(text) for text in ["if (server) fail('PHASE_SERVER_STILL_OPEN')", 'currentMeet = meetLifecycle.phase();', wrapped.strip(), 'loader.resetCompiled();', 'currentPorts = recordingPorts(', "const express = require('express')"]]
checks = {
 'complete_other_bootstrap_bytes_preserved': reversed_source == baseline,
 'all_original_645_unit_code_preserved': reversed_unit == old_unit,
 'private_sync_guard_and_finally_exact': source.count(window) == 1 and source.count('containerResetWindow') == 5,
 'destroy_exception_exact_and_context_bound': source.count(new_get) == 1 and "if (key === 'destroy') return undefined" not in source,
 'actual_loader_same_boundary_forward': source.count(forward) == 1,
 'one_existing_reset_call_inside_only_wrapper': source.count(wrapped) == 1 and source.count("typedi.Container.of().reset({ strategy: 'resetServices' })") == 1,
 'phase_order_unchanged': all(value >= 0 for value in positions) and positions == sorted(positions),
 'no_new_exports_or_context_provider_fields': source[source.find('module.exports = '):] == baseline[baseline.find('module.exports = '):],
 'all_four_cut_classes_and_window_cases': all(name in unit[start:end] for name in ['BookingRepository', 'BookingService', 'SlotRepository', 'SlotService'])
   and all(label in unit[start:end] for label in ['INERT_', 'OUTSIDE_DENIED_', 'BUSINESS_DENIALS_', 'UNKNOWN_DENIALS_', 'MUTATIONS_DENIED_', 'THROW_CLOSES_', 'NESTED_RETAINS_OUTER_', 'ASYNC_CONTINUATION_CLOSED_']),
 'actual_forwarder_repeated_fake_probe_test': 'PROFILE_RESET_ACTUAL_LOADER_FORWARDING_FAKE_RESET_REPEAT' in unit[start:end] and 'probeReads === 12 && destroyDelegates === 0' in unit[start:end],
}
contract = json.loads((ROOT / 'output/qa/week2-profile-lifecycle-contract/inputs.json').read_text())
pins = {name: sha((ROOT / name).read_bytes()) == digest for name, digest in contract['repositoryFiles'].items() if name not in OWNED}
public = {name: sha(Path(name).read_bytes()) == digest for name, digest in contract['publicFiles'].items()}
artifact = json.loads((ROOT / 'output/qa/week2-api-preparation/emission-13/runtime-template.json').read_text())
source_bindings = {name: sha((ROOT / name).read_bytes()) == digest for name, digest in artifact['sourceFiles'].items() if name != BOOT}
actual = json.loads((ROOT / QA / 'unit.json').read_text())
parser = json.loads((ROOT / QA / 'parser-unit.json').read_text())
negative = json.loads((ROOT / QA / 'weakening-controls.json').read_text())
red = json.loads((ROOT / QA / 'baseline/red-result.json').read_text())
checks['actual_680_and_retained_49'] = actual['cases'] == 680 and actual['failed'] == 0 and parser['cases'] == 49 and parser['failed'] == 0
checks['actual_zero_application_or_native_attempts'] = all(actual[key] == 0 for key in ['applicationImports', 'connections', 'domainWrites', 'nativeChildLoads', 'nativeWarningDelegates']) and all(parser[key] == 0 for key in ['applicationImports', 'connections', 'writes', 'compilerExecutions', 'applicationHelperEvaluations'])
checks['actual_prepatch_red_retained'] = red['exitCode'] == 1 and red['bootstrapSha256'] == sha(baseline.encode()) and red['actualResult']['profileCase'] == 'PROFILE_RESET_WINDOW_INERT_BookingRepository'
checks['actual_five_weakening_failures_and_restore'] = negative['status'] == 'PASS' and len(negative['controls']) == 5 and all(row['rejected'] for row in negative['controls']) and negative['restoredExactNominal'] and negative['nominalSourceSha256'] == sha(source.encode())
changed = set(subprocess.check_output(['git', 'diff', '--name-only', BASE], cwd=ROOT, text=True).splitlines())
untracked = set(subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'], cwd=ROOT, text=True).splitlines())
unknown = sorted(name for name in changed | untracked if name not in OWNED and not name.startswith(QA))
regular = all((ROOT / name).is_file() and not (ROOT / name).is_symlink() and (ROOT / name).stat().st_nlink == 1 and (ROOT / name).stat().st_mode & 0o777 == 0o644 for name in OWNED)
scope = not unknown and OWNED.issubset(changed) and regular
status = 'PASS' if all(checks.values()) and all(pins.values()) and all(public.values()) and all(source_bindings.values()) and len(source_bindings) == 104 and scope else 'FAIL'
report = {'schema':'SD-PROFILE-LIFECYCLE-SOURCE-AUDIT-1','status':status,'baseline':BASE,'checks':checks,'checkCount':len(checks),
 'unchangedContractRepositoryInputs':pins,'unchangedPublicInputs':public,'unchangedOther104PreparedSourceBindings':source_bindings,
 'scope':{'exactOwnedTwoChanged':OWNED.issubset(changed),'unexpectedPaths':unknown,'ownedQaPrefix':QA,'regular644SingleLinkFiles':regular},
 'limits':'Own lane exact two-source/owned-QA scope, valid across commits. Root separately reviews any wider integration union. Full source inverses preserve old code; pure fixture/fake TypeDI probes are not package/app/runtime evidence.'}
print(json.dumps(report,indent=2))
sys.exit(0 if status == 'PASS' else 1)
