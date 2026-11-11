'use strict';
// AUTHOR-ONLY exact fixture-module redirection. No runtime alternate path.
const Module = require('node:module');
const fs = require('node:fs');
const crypto = require('node:crypto');
const unit = "/private/tmp/swasthadisha-parallel-p1qom53w/week2-profile-warning-bootstrap/test/api-runtime/scenario/bootstrap-unit.cjs";
const target = "/private/tmp/swasthadisha-parallel-p1qom53w/week2-profile-warning-scenario/test/api-runtime/scenario/scenario.cjs";
const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
if (digest !== 'cbb1260c887a7a5dc664fec9a6b47c680e1d180f78b102716122596baaae6500') throw new Error('WARNING_ACTUAL_SCENARIO_HASH');
const original = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './scenario.cjs' && parent && parent.filename === unit) return original.call(this, target, parent, isMain);
  return original.call(this, request, parent, isMain);
};
