# First approved real application smoke evidence

Executed once at clean approved commit `de1693ed80538099bab2874a3ea8254df5f62143` on 10 November 2026. Outcome **FAIL** at the strict sysfs interface listing assertion. Exact container/workspace cleanup was acknowledged and independently verified on the same engine. No retry occurred.

`verification.json` distinguishes measured outcomes and NOT_RUN work. `operator-result.json` lists the explicit Docker commands and stdout/stderr files. `launcher.stderr.txt` contains the exact assertion and resource records; stdout is empty. The three source-freeze records capture clean approved HEAD, all 71 hash matches and the helper hash before caching, before launch and after launch.

`operator.py` is the historical capture recipe, archived as text for inspection. Do not execute it as a retry instruction; the one-run approval is consumed. `blank-docker-config.json` contains only newly created empty auths, not operational configuration. The extra operator evidence/config workspace was archived then removed; its separate cleanup record is not a substitute for the container/workspace absence proof. The approved public image remains cached.

The bootstrap failed before later permission/HTTP checks, dynamic ports/scenario/helper imports and seven receipts. Extra sysfs names were observed; their state, addresses and routes were not measured. No root dependency/start/application change or full C3/M0/domain/100 RPS acceptance follows. Use the failure-review prompt before any new runtime attempt.
