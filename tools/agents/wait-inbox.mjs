#!/usr/bin/env node
// Blocks until a NEW message lands in one agent's local Ruflo mailbox, then prints it and exits.
// Read-only: it never drains or edits mail; read it afterwards with team_inbox.
//
// Usage: node tools/agents/wait-inbox.mjs <agent> [--team swasthadisha-local] [--timeout-min 9] [--since <epochMs>]
//   Exit 0: new mail (one line per message: id | from | type | summary). Exit 2: timeout, nothing new.
//   --since defaults to "now", so old unread messages are ignored.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const agent = args[0];
const opt = (name, fallback) => { const i = args.indexOf(name); return i > 0 && args[i + 1] ? args[i + 1] : fallback; };
const name = /^[A-Za-z0-9_-]{1,64}$/;
const team = opt('--team', 'swasthadisha-local');
if (!agent || !name.test(agent) || !name.test(team)) {
  console.error('usage: wait-inbox.mjs <agent> [--team <team>] [--timeout-min <n>] [--since <epochMs>]');
  process.exit(64);
}
const timeoutMs = Math.max(1, Number(opt('--timeout-min', '9'))) * 60_000;
const since = Number(opt('--since', String(Date.now())));
const dir = join(process.env.RUFLO_STATE_DIR ?? join(homedir(), '.codex/ruflo-state/swasthadisha'), '.claude-flow/teams', team, 'mailbox', agent);
const file = /^\d{3}_msg_(\d{13})_[A-Za-z0-9]+\.json$/;

function fresh() {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter(n => { const m = file.exec(n); return m && Number(m[1]) > since; }).sort();
}

const deadline = Date.now() + timeoutMs;
for (;;) {
  const found = fresh();
  if (found.length) {
    for (const n of found) {
      try {
        const m = JSON.parse(readFileSync(join(dir, n), 'utf8'));
        console.log([m.id, m.from, m.type, String(m.summary ?? '').replace(/\s+/g, ' ').slice(0, 200)].join(' | '));
      } catch { console.log(n + ' | (unreadable)'); }
    }
    process.exit(0);
  }
  if (Date.now() >= deadline) { console.log('timeout: no new mail for ' + agent); process.exit(2); }
  await new Promise(r => setTimeout(r, 3000));
}
