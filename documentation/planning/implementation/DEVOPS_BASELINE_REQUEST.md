# Existing-server baseline handoff

**10 November 2026. Owner decision: retain the existing server; DevOps will supply facts.** This is an information request for C2, not permission to connect, provision, migrate or deploy.

Provide the non-secret fields below for the intended pre-launch environment. Use a logical environment name and existing config/runbook path where possible. Keep credentials, connection strings, tokens, private keys, environment dumps and patient data out of this record.

| Required field | DevOps response | Purpose / latest gate |
| --- | --- | --- |
| Logical environment name and region | PENDING | Confirm which existing server the build targets; before root adoption |
| Node exact version, OS and CPU architecture | PENDING | Verify supported packages/native modules; before runtime/dependency pin |
| PM2 version, logical app name, script path, cwd and interpreter | PENDING | Resolve owner-reported pm2 start server; before startup edits |
| Build command, compiled output and source revision | PENDING | Reconcile TypeScript build and aliases; before build/start adoption |
| MongoDB hosting type and exact server version | PENDING | Select a supported ODM/driver/server combination; before root dependency adoption |
| MongoDB topology and feature compatibility version | PENDING | Establish transaction capability and migration constraints; before affected data/runtime adoption |
| Existing relevant client source/build revisions, or explicitly none enabled | PENDING | Preserve legitimate current calls; before affected containment contracts |
| Baseline recorder and check date | PENDING | Make these actual observations rather than assumptions |

Known owner facts remain: pre-launch, Node major 22, Mumbai location and reported command `pm2 start server`. Local Node 22.23.4 and local MongoDB 8.0.34 are test tooling; they do not fill these deployment fields.

Backend can continue the approved static-only compatibility investigation and other independently admitted work. Once DevOps fills this record, review the exact intended target and root migration diff. C3 application/provider admission, M0 acceptance and release remain separate gates.
