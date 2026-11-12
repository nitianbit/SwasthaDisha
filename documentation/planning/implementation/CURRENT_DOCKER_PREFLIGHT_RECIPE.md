# Current local Docker metadata preflight — review candidate

12 November 2026. Author: internal Codex `/root/claude_review_5_packet`. **AMENDED AFTER SECOND METADATA ATTEMPT; TWO FRESH REVIEWS REQUIRED.** The second attempt observed the known Linux engine/server29.6.2, then failed at the optional Volumes template lookup. Full cache validation remains incomplete; continuing availability is not inferred from that snapshot. Root selected the existing Docker C3 boundary for the next focused SDK/application investigation. This recipe permits at most two read-only Docker CLI commands after two actual independent nonauthor exact-recipe decisions. It does not launch a container, pull an image, start Docker Desktop/the daemon, import JavaScript/application/SDK code, inspect unrelated resources or change the target. No new general operator or host network-denial framework is introduced.

## Evidence retained and the next boundary

- [Network semantic contract](APP_NETWORK_ADMISSION_CONTRACT.md) and [offline verification](../../../output/qa/foundation-network-admission/verification.json): 324 cases on each pinned Node runtime, nine fake-port probe cases and 13 detected weakened variants. All17 recorded changed/unchanged source pins match the focus worktree during this preparation. These are retained results, not rerun here.
- [Batch 3 review](../../../output/qa/batch3-network-recipe/REVIEW.md), [verification](../../../output/qa/batch3-network-recipe/verification.json) and [raw result](../../../output/qa/batch3-network-recipe/execution-1/operator-result.json): **one actual PASS_FIXED_NO_DB_SCENARIO at clean `eba7e5c82e3ff63af9e9a958fbd100733e1fc439` on 10 November**. It includes the semantic network check, permission canaries, unchanged search helper, seven recorded/effect:false ports and exact same-engine/container/workspace cleanup. That approval is consumed. This historical pass is not current daemon availability, driver initialization or full C3 acceptance. No repeat of unchanged work is implied.
- The old [batch 3 operator](../../../output/qa/batch3-network-recipe/operator.py) supplied the explicit endpoint, blank-config, image-metadata and fixed-argument patterns. Its historical command, target checkout and consumed receipt are not invoked or repointed. The [diagnostic preflight operator](../../../output/qa/m0-a/app-isolation/diagnostic-preflight-2026-11-10/operator.py) and `41539ca`-bound approval remain historical; neither grants execution at current HEAD. Earlier failed smokes and their cleanup records stay unchanged.
- [C2 conditions](../M0_START_APPROVAL_STATUS.md), [foundation usage](../../../test/foundation/README.md), [C3 fixture contract](C3_MONGO_FIXTURE_CONTRACT.md) and [application isolation contract](C3_APP_ISOLATION_CONTRACT.md) remain. A later semantic smoke, SDK constructor/import or focused application check needs its own exact source/fixture/stub freeze, complete pre-import admission and two actual source/invocation decisions. Metadata success alone supplies none of those. The host `sandbox-exec` draft remains inert fallback. Final cross-module integration remains deferred by the owner.

## Fixed inputs and preparation observations

Only exact executable/symlink/socket metadata and regular executable bytes were read during preparation. No user Docker config, contexts, credentials, keychain, daemon API or protected data was read. Socket existence is not evidence that a daemon accepts connections.

| Input | Fixed value / observed pin |
| --- | --- |
| Endpoint | `unix:///Users/shubham/.docker/run/docker.sock` |
| Expected Linux engine ID | `16ab25f6-88c7-4687-a431-b119b6ab9319` |
| Cached image only | `node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d` |
| Python executable | `/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14` |
| Python SHA-256 | `87d4df53fd91304be5bac391fb204643c36b7df2023c04a0953bcbc7d4fdf634` |
| Canonical Docker executable | `/Applications/Docker.app/Contents/Resources/bin/docker` |
| Docker SHA-256 / size | `31201b50f14101c2a2bd8a1fdc49055f985d5007d5ba86c177ad2dedfa309b9b` / 41,392,016 bytes |
| Docker metadata | Regular file, mode0755, owner501, device16777233/inode1908573 |
| Historical CLI alias, metadata only | `/usr/local/bin/docker`, root-owned symlink, device16777233/inode1914533, target exactly the canonical executable above. The command below executes the canonical file directly. |
| Socket metadata | Socket, owner501, device16777233/inode54259605, mode0755; no symlink observed |

Revalidate these pins immediately before either command. Missing or changed executable/socket, unreachable daemon, wrong engine/OS, missing cached digest, wrong platform/environment or any command/capture failure stops. Do not repair, repin, switch context/endpoint, search for another engine/image, pull, start a daemon or retry automatically. A legitimate local change needs fresh metadata and an amended review candidate.

## Exact prospective invocation — NOT RUN

Root first records TWO FRESH actual independent nonauthor failure/source/invocation decisions approving **ONE_READ_ONLY_LOCAL_DOCKER_PREFLIGHT** on this amended candidate; both previous attempts' decisions are historical and cannot authorize a retry. Those fresh decisions approve, binding this complete file's SHA-256, fixed inputs, the code below and its limits. Root rechecks that exact recipe hash before invocation and records the exact Python executable hash. A preparation/source approval is not that execution decision. No receipt, attempt directory or Docker process is created by preparing this document. The owner has already authorized bounded local development; no new general start approval or prompt relay is requested.

The only prospective command is the following fixed heredoc. It accepts no target/command arguments. The inline Python is part of the reviewed recipe, not a reusable operator. It allocates a new private evidence area, owns an empty HOME/tmp/blank Docker auth config, and runs only `info --format` then `image inspect` for the one digest. `info` emits only ID, server version and OS. Image inspection emits only ID, digests, platform, declared volumes and image environment. No `ps`, container/volume/network/context listing, login, daemon start or launch operation is included.

Each Docker command receives only constructed PATH/HOME/TMPDIR/LC_ALL, explicit `--config` and `--host`. There is no ambient Docker/preload/provider configuration. Each has a configured 25-second subprocess timeout, stdin closed and exclusive private stdout/stderr files capped at 64KiB each through child `RLIMIT_FSIZE`; reaching the cap rejects. This uses the existing trusted host/CLI/Python boundary, not a malicious-client sandbox or whole-runtime byte closure. All evidence/config files are retained; no recursive deletion or unrelated cleanup occurs.

```sh
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14 -I -S -B - <<'PY'
from pathlib import Path
import hashlib, json, os, resource, stat, subprocess, tempfile
RECIPE = Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab/documentation/planning/implementation/CURRENT_DOCKER_PREFLIGHT_RECIPE.md')
PYTHON = Path('/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14')
DOCKER = Path('/Applications/Docker.app/Contents/Resources/bin/docker')
SOCKET = Path('/Users/shubham/.docker/run/docker.sock')
ENDPOINT = 'unix:///Users/shubham/.docker/run/docker.sock'
ENGINE = '16ab25f6-88c7-4687-a431-b119b6ab9319'
IMAGE = 'node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d'
def need(ok):
    if not ok: raise RuntimeError('FIXED_PREFLIGHT_REJECTED')
def digest(data): return hashlib.sha256(data).hexdigest()
def identity(path):
    s=path.lstat(); return (s.st_dev,s.st_ino,s.st_uid,stat.S_IMODE(s.st_mode),'directory' if stat.S_ISDIR(s.st_mode) else s.st_nlink)
def pins():
    for path,expected,size in [(PYTHON,'87d4df53fd91304be5bac391fb204643c36b7df2023c04a0953bcbc7d4fdf634',34640),(DOCKER,'31201b50f14101c2a2bd8a1fdc49055f985d5007d5ba86c177ad2dedfa309b9b',41392016)]:
        s=path.lstat(); need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o755 and s.st_size==size)
        need(path.resolve(strict=True)==path and digest(path.read_bytes())==expected)
    need(identity(DOCKER)==(16777233,1908573,501,0o755,1))
    need(stat.S_ISSOCK(SOCKET.lstat().st_mode) and SOCKET.resolve(strict=True)==SOCKET)
    need(identity(SOCKET)[:4]==(16777233,54259605,501,0o755))
pins()
area=Path(tempfile.mkdtemp(prefix='sd-docker-metadata-',dir='/private/tmp')); os.chmod(area,0o700)
print(json.dumps({'evidenceDirectory':str(area),'phase':'ALLOCATED_NO_DOCKER_YET'}),flush=True)
held={area:identity(area)}
for name in ['docker','home','tmp']:
    p=area/name; p.mkdir(mode=0o700); held[p]=identity(p)
config=area/'docker'/'config.json'; config.write_bytes(b'{"auths":{}}\n'); config.chmod(0o600); held[config]=identity(config)
report={'schema':'SD-CURRENT-DOCKER-METADATA-1','recipeSha256':digest(RECIPE.read_bytes()),'status':'IN_PROGRESS','commands':[],'DockerLaunches':0,'imagePulls':0,'appImports':0}
def owned():
    need(all(identity(p)==value for p,value in held.items()))
    need(config.read_bytes()==b'{"auths":{}}\n')
def limit_output(): resource.setrlimit(resource.RLIMIT_FSIZE,(65536,65536))
steps=[('info',['info','--format','[{{json .ID}},{{json .ServerVersion}},{{json .OSType}}]']),('image',['image','inspect','--format','[{{json .Id}},{{json .RepoDigests}},{{json .Os}},{{json .Architecture}},{{json (index .Config "Volumes")}},{{json .Config.Env}}]',IMAGE])]
try:
    for label,args in steps:
        owned(); pins(); row={'step':label,'attempted':True,'processStarted':'UNKNOWN'}; report['commands'].append(row)
        out=area/(label+'.stdout.txt'); err=area/(label+'.stderr.txt')
        with out.open('xb') as stdout,err.open('xb') as stderr:
            os.fchmod(stdout.fileno(),0o600); os.fchmod(stderr.fileno(),0o600)
            try:
                result=subprocess.run([str(DOCKER),'--config',str(area/'docker'),'--host',ENDPOINT,*args],cwd=area,env={'PATH':'/usr/bin:/bin','HOME':str(area/'home'),'TMPDIR':str(area/'tmp'),'LC_ALL':'C'},stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,timeout=25,preexec_fn=limit_output,check=False)
            except subprocess.TimeoutExpired:
                row.update(processStarted=True,timedOut=True); raise
            row.update(processStarted=True,exitCode=result.returncode)
        owned(); pins(); need(out.stat().st_size<65536 and err.stat().st_size<65536 and result.returncode==0)
        data=out.read_bytes(); need(len(data)<65536); value=json.loads(data)
        row.update(stdoutSha256=digest(data),stderrSha256=digest(err.read_bytes()))
        if label=='info':
            need(isinstance(value,list) and len(value)==3 and value[0]==ENGINE and value[2]=='linux' and isinstance(value[1],str) and 0<len(value[1])<=128)
            report['engine']={'id':value[0],'serverVersion':value[1],'os':value[2]}
        else:
            need(isinstance(value,list) and len(value)==6)
            image_id,digests,os_name,arch,volumes,environment=value
            need(image_id=='sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d' and isinstance(digests,list) and IMAGE in digests and os_name=='linux' and arch=='arm64' and volumes in [None,{}])
            need(isinstance(environment,list) and all(isinstance(x,str) and '=' in x for x in environment))
            entries=[x.split('=',1) for x in environment]; need(len({k for k,v in entries})==len(entries))
            values=dict(entries); need(set(values)=={'PATH','NODE_VERSION','YARN_VERSION'} and values['PATH']=='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' and values['NODE_VERSION']=='22.23.4' and values['YARN_VERSION']=='1.22.22')
            report['image']={'id':image_id,'digest':IMAGE,'os':os_name,'architecture':arch,'volumesAbsent':True,'environmentMatched':True}
    report['status']='METADATA_PREFLIGHT_PASS_ONLY'
except BaseException as error:
    report.update(status='METADATA_PREFLIGHT_BLOCKED',failureType=type(error).__name__)
finally:
    try:
        owned()
        with (area/'result.json').open('xb') as output:
            os.fchmod(output.fileno(),0o600); output.write((json.dumps(report,indent=2)+'\n').encode())
    except BaseException as error:
        report.update(status='METADATA_PREFLIGHT_UNRESOLVED',recordingFailureType=type(error).__name__)
    print(json.dumps({'evidenceDirectory':str(area),'status':report['status'],'commands':report['commands'],'failureType':report.get('failureType'),'recordingFailureType':report.get('recordingFailureType')}),flush=True)
raise SystemExit(0 if report['status']=='METADATA_PREFLIGHT_PASS_ONLY' else 1)
PY
```

## Preparation verification

During initial preparation, the exact inline Python was parsed as data with Python AST only; it was not executed then. Historical cached-image JSON confirmed the chosen arm64 ID and exact PATH/NODE_VERSION/YARN_VERSION values. The Docker binary/socket pins above came only from targeted filesystem metadata/byte reads. No Docker/Node, socket connection, network request, user-config access, new evidence area or model request occurred during that initial preparation. The subsequent first attempt and filesystem-only amendment regression are recorded separately below; they are not erased by this historical preparation statement. Code SHA-256 (UTF-8 body between the quoted heredoc delimiters, excluding the final delimiter/newline): `76a85e7d4ad1448d3fd290d632a022da24a4fb2d06a03f2e52d9865069dc5823`. Root binds the complete final recipe hash separately; it cannot contain its own SHA-256.

## Directory identity amendment after first failure

Root reported one exact attempt at the original recipe9207133a18b2dd122f1f9c6e324a89fed03afdd7a494f7b2ae150c6e787405c5. It allocated `/private/tmp/sd-docker-metadata-8p9__tlp`, then stopped with `METADATA_PREFLIGHT_UNRESOLVED`, `commands:[]`, both failure types RuntimeError and exit1. No Docker process/query started and no result file was written. Source cause: `held[area]` captured directory `st_nlink` before creating three subdirectories; that expected filesystem change made the first `owned()` reject, and the same check prevented final result recording. Exact failed recipe/code and attributed failure metadata are retained in [failure-1](../../../output/qa/current-docker-preflight/failure-1/README.md). The failed area remains unchanged; no deletion or daemon operation follows.

The inline program changes exactly ONE expression in `identity`: its final tuple field is the literal `directory` marker only when `stat.S_ISDIR` is true; every other kind retains its actual link count. Device, inode, owner and permission mode remain bound. Directory replacement/kind changes still reject; regular-file hard-link drift still rejects. Docker/socket/executable pins, commands, environment, config bytes, caps, accounting and failure handling are unchanged. The admitted filesystem-only regression in [revision-1](../../../output/qa/current-docker-preflight/revision-1/README.md) executes only the exact extracted identity/owned functions with owned toy fixtures, never the inline program or Docker code. Its measured result must be read before review; synthetic filesystem checks are not Docker reachability or network evidence.

## Optional image-volume field amendment after second attempt

Root ran the directory-amended recipe4cee25450e4ce174084e6f70722cf51517525914ba98e60755e369ee53e3e57f once after both fresh reviews. The preserved result at `/private/tmp/sd-docker-metadata-jo56fyus` is METADATA_PREFLIGHT_BLOCKED. Actual `info` exited0 with the expected engine16ab25f6-88c7-4687-a431-b119b6ab9319, Linux and server29.6.2; stderr was empty. `image inspect` exited1 because the strict template lookup `.Config.Volumes` found no such optional map entry. Its error is retained exactly in [failure-2](../../../output/qa/current-docker-preflight/failure-2/README.md). Two metadata processes ran; no container launch, pull or application import occurred. This is a template failure, not evidence of an unreachable daemon or missing image. Complete image metadata validation did not finish.

The sole current inline amendment is `{{json .Config.Volumes}}` → `{{json (index .Config "Volumes")}}`. The other five image fields, Python `volumes in [None,{}]` requirement, every pin, directory/regular-file identity guard, query, environment, config and output/time cap remain unchanged. Nonempty declared volumes remain rejected. Exact inverse recovery and AST parsing are data-only checks; no fake Go parser/model test or repeat of the eight unchanged filesystem regressions is used.

Root verified the primary [Go template index implementation](https://go.dev/src/text/template/funcs.go), where absent map keys return the element type's zero value, and [Docker formatting documentation](https://docs.docker.com/engine/cli/formatting/), which describes Go templates and the json helper. **Inference:** for this map-valued Config response, index should yield nil for an absent Volumes key, allowing json to emit null and the unchanged Python condition to accept absence. Actual compatibility with this installed Docker CLI still requires the next separately reviewed one-time metadata attempt; this reasoning is not an executed Docker result. This worker made no network request while preparing the amendment.

The retained directory-identity regression remains8/8 with exact toy-fixture cleanup; its source function is unchanged. See [revision-2](../../../output/qa/current-docker-preflight/revision-2/README.md) for the compact final freeze, exact inverse proof and preserved execution provenance. Both earlier recipe decisions remain historical; TWO FRESH independent nonauthor failure/source/exact one-invocation decisions precede any Docker retry. There is no automatic retry or new container/app admission.

## Interpretation and stop conditions

`METADATA_PREFLIGHT_PASS_ONLY` means that the two fixed read queries completed and the known local engine/cache matched at that time. It is not proof of interface/routing/kernel behavior, namespace provenance, actual driver constructor/DB transactions, provider isolation, application imports, current deployment or C2/C3/module/release acceptance. The raw bounded streams and result remain in the newly owned evidence directory for independent readback. Blank auth config is not an operational credential and must not be populated.

Any failure, incomplete process accounting, timeout, changed identity or uncertain output remains blocked with its known attempted/started fields retained. Stop before the next step; preserve evidence. No implicit retry, fall back to an operational resource, broad resource discovery or cleanup mutation is allowed. Root obtains an actual review of a concrete amended recipe before a new attempt. A later focused invocation uses a separately reviewed current clean source freeze, retained semantic-network source/evidence and complete SDK/app/provider/DB admission; an old clean-checkout approval is never transplanted to the active worktree. Nothing in this file modifies or broadens the concurrent R6 Claude capture/profile or its selected inputs.
