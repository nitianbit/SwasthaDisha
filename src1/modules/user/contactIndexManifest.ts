/** Fixed diagnostic metadata requirements. A declaration is not installed-index or rollout evidence. */
export const USER_CONTACT_INDEX_MANIFEST = Object.freeze({
  schema: 'SD-USER-CONTACT-INDEX-MANIFEST-1',
  collection: 'users',
  mode: 'MONGODB_8_INCLUDE_INDEX_BUILD_INFO',
  requiredName: 'user_contact_keys_v1',
  key: Object.freeze([Object.freeze(['contactKeys', 1] as const)]),
  unique: true, sparse: false, hidden: false, expireAfterSeconds: null,
  partialFilterExpression: Object.freeze({ contactKeys: Object.freeze({ $type: 'array' }) }),
  effectiveCollation: 'simple',
  maxIndexRows: 64, maxLogicalMetadataBytes: 262144, maxElapsedMs: 5000,
});
