'use strict';
const Module = require('node:module');
const fs = require('node:fs');
const crypto = require('node:crypto');
const owner = "/private/tmp/swasthadisha-parallel-p1qom53w/week2-profile-warning-bootstrap/output/qa/week2-profile-warning-bootstrap/controls-1/owned-warning-control-89avk65y/bootstrap-unit.cjs";
const target = "/private/tmp/swasthadisha-parallel-p1qom53w/week2-profile-warning-scenario/test/api-runtime/scenario/scenario.cjs";
if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== 'cbb1260c887a7a5dc664fec9a6b47c680e1d180f78b102716122596baaae6500') throw new Error('WARNING_ACTUAL_SCENARIO_HASH');
const held = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './scenario.cjs' && parent && parent.filename === owner) return held.call(this, target, parent, isMain);
  return held.call(this, request, parent, isMain);
};
