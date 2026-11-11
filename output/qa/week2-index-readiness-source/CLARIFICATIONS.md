# Lead implementation clarifications

The frozen contract d626f54222ab4f60f32bf9c94c97f3815ec8f71e35bebd5f604d58fb0ac01459
is unchanged. Lead /root confirmed these interpretations directly to the author
/root/index_readiness_library before the relevant implementation was finalized:

- Own data indexBuildInfo/buildUUID markers at COMPLETE wrapper OR spec metadata
  level mean OBSERVATION_UNREADY, with values opaque including undefined, cycles,
  native objects, false and null. Accessor markers are OBSERVATIONS_INVALID with
  no getter invocation. Nested partial-filter keys are query data, not markers.
  Copies made through admitted descriptors avoid later caller-object rereads.
- Malformed required spec name/key or malformed typed supported options/v/ns/
  background are OBSERVATIONS_INVALID. Bare row specs, absent wrapper spec,
  unknown wrapper/spec fields, valid-data unsupported collation and unfamiliar
  string modes are OBSERVATION_UNSUPPORTED. Missing listing fields, nonstring
  mode, unknown status and present null/nonobject spec are invalid. Global
  structure/bounds/duplicates precede collection refusals. Status precedes
  unsupported metadata/mode, then building, then required-index comparison.
- Every explicit manifest vector containing reserved _id is rejected, including
  -1 and compound forms. This is a conservative supported-manifest boundary,
  not a MongoDB prohibition. Observed completed unrelated compound _id extras
  may still be ignored after all validation. The implicit uniqueness exception
  remains only name _id_ with exact single ordered key [["_id",1]].

The selected thirteen-collection/eight-explicit-index caller policy is not copied
into the library. No caller, runtime adapter, command, startup or enforcement
was introduced. Helper functional behavior and type correctness remain NOT_RUN.
