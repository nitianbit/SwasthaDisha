"""Offline preparation checks, not native CLI protocol or live admission proof.

Reads this owned QA directory only. No subprocess/socket/provider/application
imports, actual mailbox calls, writes or cleanup effects exist in this checker.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent

def digest(data):
    return hashlib.sha256(data).hexdigest()

def require(ok):
    if not ok:
        raise ValueError('OFFLINE_EVIDENCE_REJECTED')

def normalized_trace(trace, recipe, challenge):
    """Exercise correlation rules on synthetic normalized evidence only.

    These records are NOT an asserted supported native stream schema. A real
    supervisor must preserve actual stream and Root inspects its mapping/results.
    """
    require(trace['clientKind'] == 'local-bundled-CLI')
    require(trace['model'] == recipe['requestedModel'])
    require(trace['sessionId'] == recipe['sessionId'])
    require(trace['normalExit'] is True and trace['cleanup'] == 'ALL_OBSERVED_ABSENT')
    require(trace['forcedCleanup'] is False)
    calls = trace['calls']
    require(len(calls) == 3)
    require(calls[0]['method'] == 'team_inbox')
    require(calls[0]['args'] == {'team': challenge['team'], 'agent': challenge['toAgent'], 'peek': True})
    require(calls[0]['id'] == 'inbox-1' and calls[0]['resultFor'] == 'inbox-1')
    require(calls[0]['ok'] is True)
    # Actual inbox-returned fields must agree with the fresh challenge. Merely
    # knowing/reading a prepared nonce file would never be a real inbox receipt.
    fields = ('nonce', 'sessionId', 'sourceCommit', 'controllerSha256', 'contractSha256', 'packetSha256')
    require(all(calls[0]['returnedChallenge'][k] == challenge[k] for k in fields))
    require(len({c['id'] for c in calls}) == 3)
    for n, call in enumerate(calls[1:], 1):
        require(call['method'] == 'team_send' and call['ok'] is True)
        require(call['resultFor'] == call['id'])
        require(call['args']['team'] == challenge['team'])
        require(call['args']['from'] == challenge['toAgent'])
        require(call['args']['to'] == challenge['fromAgent'])
        require(all(call['body'][k] == challenge[k] for k in fields))
        require(call['body']['kind'] == ('CONNECTIVITY_ACK' if n == 1 else 'SOURCE_REVIEW'))
    review = calls[2]['body']['review']
    require(40 <= len(review.encode()) <= recipe['bounds']['reviewBytes'])
    require(trace['finalText'] == review)
    require(calls[2]['body']['outcome'] in recipe['reviewOutcomes'])
    effort = trace['effectiveEffort']
    if effort is None:
        return 'REVIEW_RECEIVED_EFFORT_UNPROVEN'
    require(trace['effortProvenance'] == 'SUPPORTED_APPLICABLE_ACTUAL_METADATA')
    require(effort == recipe['requestedEffort'])
    return 'REVIEW_RECEIVED_REQUESTED_MODE_OBSERVED'

def main():
    recipe = json.loads((BASE / 'recipe.json').read_text())
    packet_bytes = (BASE / 'packet.json').read_bytes()
    packet = json.loads(packet_bytes)
    manifest = json.loads((BASE / 'manifest.json').read_text())
    challenge = json.loads((BASE / 'challenge.json').read_text())
    prior = json.loads((BASE / 'prior-seven.sha256.json').read_text())
    checks = []
    def check(name, ok):
        require(ok)
        checks.append(name)
    check('seven prior artifacts byte-exact', all(digest((BASE.parent / name).read_bytes()) == h for name,h in prior.items()) and len(prior) == 7)
    check('packet and manifest bound', digest(packet_bytes) == recipe['packetSha256'] == manifest['packetSha256'] and digest((BASE/'manifest.json').read_bytes()) == recipe['manifestSha256'])
    check('MCP config bound', digest((BASE/'mcp-config.json').read_bytes()) == recipe['mcpConfigSha256'])
    check('changed-source not stale contract review', packet['mode'] == 'CHANGED_SOURCE' and packet['sourceCommit'] == recipe['sourceCommit'] == '11e9c8bf5f276aa520e1424cc84e17f08b151df2')
    check('controller full and exact', any(f['path'] == 'src1/modules/bookings/controller/index.ts' and f['complete'] and f['wholeFileSha256'] == recipe['controllerSha256'] == 'bbe2d226d0192b91389675dd5e66f2b385dc157bba0010715bbe4b29b0e2848b' and digest(f['excerpts'][0]['content'].encode()) == f['wholeFileSha256'] for f in packet['files']))
    check('framed excerpt hashes', all(digest(e['content'].encode()) == e['sha256'] for f in packet['files'] for e in f['excerpts']))
    check('fresh nonce absent from stdin', challenge['nonce'] not in packet_bytes.decode())
    check('new exact session', recipe['sessionId'] == recipe['argvCandidate'][-1] == challenge['sessionId'] and recipe['sessionId'] != json.loads((BASE.parent/'recipe.json').read_text())['argvCandidate'][-1])
    check('requested exact model and xhigh', recipe['requestedModel'] == 'claude-opus-5-5' and recipe['requestedEffort'] == 'xhigh' and recipe['argvCandidate'][recipe['argvCandidate'].index('--effort')+1] == 'xhigh')
    check('correct second-send third-call wording', 'second team_send' in packet['instruction'] and 'third tool call overall' in packet['instruction'] and 'third tool send' not in packet['instruction'])
    check('zero live calls', recipe['liveModelRequests'] == recipe['authStatusChecks'] == 0 and recipe['actualClaudeExtensionACK'] is False)
    check('fresh output and claim not adopted', not Path(recipe['onceClaim']).exists() and not Path(recipe['privateOutputDirectory']).exists())
    fields = ('nonce','sessionId','sourceCommit','controllerSha256','contractSha256','packetSha256')
    body = {k:challenge[k] for k in fields}
    review = 'REQUEST_CHANGES: synthetic fixture only; actual source review was not performed.'
    sends = []
    for n,kind in enumerate(('CONNECTIVITY_ACK','SOURCE_REVIEW'),1):
        b = dict(body,kind=kind)
        if n == 2:
            b.update(review=review,outcome='REQUEST_CHANGES')
        sends.append({'method':'team_send','args':{'team':challenge['team'],'from':challenge['toAgent'],'to':challenge['fromAgent']},'id':'send-'+str(n),'resultFor':'send-'+str(n),'ok':True,'body':b})
    trace = {'clientKind':'local-bundled-CLI','model':'claude-opus-5-5','sessionId':recipe['sessionId'],'normalExit':True,'forcedCleanup':False,'cleanup':'ALL_OBSERVED_ABSENT','effectiveEffort':None,'effortProvenance':'UNPROVEN','calls':[{'method':'team_inbox','args':{'team':challenge['team'],'agent':challenge['toAgent'],'peek':True},'id':'inbox-1','resultFor':'inbox-1','ok':True,'returnedChallenge':deepcopy(challenge)},*sends],'finalText':review}
    check('synthetic request changes useful effort unproven', normalized_trace(trace,recipe,challenge) == 'REVIEW_RECEIVED_EFFORT_UNPROVEN')
    observed = deepcopy(trace)
    observed.update(effectiveEffort='xhigh',effortProvenance='SUPPORTED_APPLICABLE_ACTUAL_METADATA')
    check('synthetic applicable observed xhigh distinguished', normalized_trace(observed,recipe,challenge) == 'REVIEW_RECEIVED_REQUESTED_MODE_OBSERVED')
    mutations = [
        ('wrong model',lambda x:x.update(model='claude-opus-4-6')),
        ('stale session',lambda x:x.update(sessionId='old-session')),
        ('native ACK claim',lambda x:x.update(clientKind='native-webview')),
        ('draining inbox',lambda x:x['calls'][0]['args'].update(peek=False)),
        ('stale nonce',lambda x:x['calls'][0]['returnedChallenge'].update(nonce='stale')),
        ('stale source',lambda x:x['calls'][0]['returnedChallenge'].update(sourceCommit='2a26c6b')),
        ('stale packet',lambda x:x['calls'][0]['returnedChallenge'].update(packetSha256='0'*64)),
        ('ACK nonce mismatch',lambda x:x['calls'][1]['body'].update(nonce='wrong')),
        ('review wrong controller',lambda x:x['calls'][2]['body'].update(controllerSha256='0'*64)),
        ('broadcast send',lambda x:x['calls'][2]['args'].update(to='*')),
        ('forged sender',lambda x:x['calls'][1]['args'].update(fromAgent='fake',**{'from':'other'})),
        ('missing send receipt',lambda x:x['calls'][2].update(ok=False)),
        ('wrong tool correlation',lambda x:x['calls'][2].update(resultFor='send-1')),
        ('extra tool call',lambda x:x['calls'].append(deepcopy(x['calls'][2]))),
        ('forbidden tool',lambda x:x['calls'][2].update(method='team_spawn')),
        ('different final review',lambda x:x.update(finalText='different')),
        ('forced cleanup',lambda x:x.update(forcedCleanup=True)),
        ('unknown cleanup',lambda x:x.update(cleanup='UNRESOLVED')),
        ('effort only assistant claimed',lambda x:x.update(effectiveEffort='xhigh',effortProvenance='ASSISTANT_TEXT')),
        ('effort downgraded',lambda x:x.update(effectiveEffort='high',effortProvenance='SUPPORTED_APPLICABLE_ACTUAL_METADATA')),
    ]
    for name,mutate in mutations:
        changed=deepcopy(trace);mutate(changed)
        try:
            normalized_trace(changed,recipe,challenge)
        except ValueError:
            checks.append('rejected synthetic '+name)
        else:
            raise AssertionError('Synthetic negative admitted: '+name)
    print(json.dumps({'result':'OFFLINE_PREPARATION_CHECKS_PASS','checks':len(checks),'syntheticNegativeCount':len(mutations),'checkNames':checks,'modelRequests':0,'authStatusRequests':0,'mailboxCalls':0,'appImports':0,'actualProcessLifecycleChecks':0,'limitation':'No actual client/model/native stream/process/cleanup behavior was executed or certified.'},indent=2))

if __name__ == '__main__':
    main()
