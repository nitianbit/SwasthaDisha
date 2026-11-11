'use strict';
// This file performs admission before requiring any package/domain module.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const ROOT = '/workspace';
const ROLE = 'auth-user-wallet-api';
// Exact authority extension policy, independent of a supplied manifest.
const ADMITTED_ROOTS = Object.freeze([
  "@/modules/auth/routes",
  "@/modules/user/routes",
  "@/modules/wallet/routes",
  "@/modules/middleware/auth",
  "@/modules/middleware/errorHandler",
  "@/modules/dependents/routes",
  "@/modules/notification/routes",
  "@/modules/fcm/routes",
  "@/modules/meet/routes",
  "@/modules/common/utils/indexReadiness"
]);
const REQUIRED_CASE_IDS = Object.freeze([
  "PHONE_LOGIN",
  "EMAIL_LOGIN",
  "LOGIN_SIDE_EFFECTS",
  "JWT_SIGNATURE_AND_CLAIMS",
  "OWN_PROFILE",
  "OWN_USER_READ",
  "OWN_USER_UPDATE",
  "OTHER_USER_READ_DENIED",
  "OTHER_USER_UPDATE_DENIED",
  "OTHER_USER_DELETE_DENIED",
  "USER_LIST_DENIED",
  "SELF_PRIVILEGE_FIELDS_DENIED",
  "OWN_WALLET_READ",
  "OTHER_WALLET_ID_DENIED",
  "OTHER_WALLET_USER_DENIED",
  "OWN_TRANSACTION_READ",
  "OTHER_TRANSACTION_DENIED",
  "TRANSACTION_WITHOUT_WALLET_OWNER",
  "WALLET_MUTATIONS_DENIED",
  "ANONYMOUS_DENIED",
  "WRONG_KEY_DENIED",
  "EXPIRED_JWT_DENIED",
  "MISSING_PRINCIPAL_DENIED",
  "MALFORMED_WALLET_ID",
  "ABSENT_WALLET",
  "ADMIN_READS",
  "HR_CORPORATE_SCOPE",
  "HR_WITHOUT_CORPORATE_DENIED",
  "SPECIALIST_AND_PHARMACY_DENIED",
  "WRONG_OTP_DENIED",
  "CONSUMED_OTP_DENIED",
  "EXPIRED_OTP_DENIED",
  "TARGET_BINDING_DENIED",
  "UNBOUND_OTP_DENIED",
  "OTP_SINGLE_WINNER",
  "OTP_INFLIGHT_EXPIRY_DENIED",
  "DEPENDENT_OWNER_CRUD_LIST",
  "DEPENDENT_ADMIN_ON_BEHALF",
  "DEPENDENT_ROLE_AND_PRINCIPAL_DENIALS",
  "DEPENDENT_OWNER_SELECTORS_DENIED",
  "DEPENDENT_HIDDEN_ID_DENIALS",
  "DEPENDENT_RAW_OWNER_FIELD_DENIALS",
  "DEPENDENT_LEGACY_VALIDATION",
  "NOTIFICATION_GENERIC_OWNER_FLOWS",
  "NOTIFICATION_GENERIC_ADMIN_FLOWS",
  "NOTIFICATION_GENERIC_DENIALS",
  "NOTIFICATION_PAGINATION_AND_COUNTS",
  "NOTIFICATION_PRIOR_STRICT_OWN_PATHS",
  "NOTIFICATION_PRIOR_SPECIALIST_PATHS",
  "NOTIFICATION_PRIOR_ADMIN_SENDERS",
  "FCM_TEST_ADMIN_RECORDING",
  "FCM_TEST_DENIALS",
  "FCM_TOKEN_REGISTRATION_COMPAT",
  "JWT_CONFIG_UNSET_DENIED",
  "JWT_CONFIG_BLANK_DENIED",
  "JWT_CONFIG_PLACEHOLDERS_DENIED",
  "JWT_CONFIG_VALID_VALUE",
  "JWT_CONFIG_PADDED_VALUE_UNCHANGED",
  "JWT_CONFIG_NONPLACEHOLDER_VALUES",
  "JWT_PUBLISHED_FALLBACK_TOKEN_DENIED",
  "MEET_URL_AUTHORITY",
  "MEET_EXCHANGE_AUTHORITY",
  "MEET_REFRESH_AUTHORITY",
  "MEET_CREATE_AUTHORITY",
  "MEET_URL_ADMIN_VALIDATION",
  "MEET_EXCHANGE_ADMIN_VALIDATION",
  "MEET_REFRESH_ADMIN_VALIDATION",
  "MEET_CREATE_ADMIN_VALIDATION",
  "MEET_URL_ADMIN_SUCCESS",
  "MEET_EXCHANGE_ADMIN_SUCCESS",
  "MEET_REFRESH_ADMIN_SUCCESS",
  "MEET_CREATE_ADMIN_SUCCESS",
  "MEET_CALLBACK_VALID_CODE_PUBLIC",
  "MEET_CALLBACK_PROVIDER_ERROR_PUBLIC",
  "MEET_CALLBACK_MISSING_CODE_PUBLIC",
  "MEET_CALLBACK_INVALID_QUERY_PUBLIC",
  "INDEX_SELECTED_READBACK",
  "INDEX_REQUIRED_REMOVAL_DENIALS",
  "INDEX_KEY_AND_IDENTITY_DENIALS",
  "INDEX_OPTIONS_DENIALS",
  "INDEX_OBSERVATION_DENIALS",
  "INDEX_INPUT_ADMISSION_DENIALS",
  "INDEX_IMMUTABILITY_AND_SAFE_RESULT"
]);
const REQUIRED_SENSITIVITY_IDS = Object.freeze([
  "OTP_UNCONDITIONAL_CONSUME",
  "OTP_LOGIN_TARGET_UNBOUND",
  "USER_OTHER_READ",
  "WALLET_OTHER_READ",
  "DEPENDENT_UNBOUND_CREATE_OWNER",
  "DEPENDENT_UNSCOPED_LIST",
  "DEPENDENT_UNSCOPED_ID_CALLS",
  "DEPENDENT_FORBIDDEN_ROLE_ADMISSION",
  "DEPENDENT_RAW_OWNER_STRIPPED",
  "NOTIFICATION_UNSCOPED_LIST",
  "NOTIFICATION_ID_OWNER_GUARD_REMOVED",
  "NOTIFICATION_PRIOR_STRICT_OWN_ADMIN_EXPANSION",
  "FCM_TEST_ADMIN_GUARD_REMOVED",
  "FCM_TEST_ADMIN_GUARD_AFTER_VALIDATION",
  "JWT_CONFIG_PUBLISHED_FALLBACK",
  "JWT_CONFIG_PRODUCTION_ONLY_GUARD",
  "JWT_CONFIG_TRIMMED_RETURN",
  "MEET_AUTHENTICATION_REMOVED",
  "MEET_ADMIN_GUARD_REMOVED",
  "MEET_GUARDS_AFTER_VALIDATION",
  "MEET_CALLBACK_GATED",
  "INDEX_MISSING_REQUIREMENT_ACCEPTED",
  "INDEX_KEY_ORDER_IGNORED",
  "INDEX_OPTIONS_IGNORED",
  "INDEX_PARTIAL_FILTER_IGNORED",
  "INDEX_INCOMPLETE_ACCEPTED",
  "INDEX_BUILD_STATUS_IGNORED"
]);
const INDEX_FAILURE_CODES = Object.freeze(["INDEX_ACQUISITION_COUNTS","INDEX_ACQUISITION_FAILED","INDEX_ACQUISITION_INCOMPLETE","INDEX_BATCH_LIMIT","INDEX_CACHE_RESTORATION","INDEX_COLLECTOR_PORTS","INDEX_COMMAND_CURSOR","INDEX_COMMAND_HANDLES","INDEX_COMMAND_INCOMPLETE","INDEX_COMMAND_NAMESPACE","INDEX_COMMAND_OBSERVER","INDEX_COMMAND_PORT","INDEX_COMMAND_REPLY","INDEX_COMMAND_STATE","INDEX_CONFLICT","INDEX_CONTINUATION_REQUIRED","INDEX_CREATE","INDEX_CURSOR_DRIFT","INDEX_CURSOR_LONG","INDEX_CURSOR_NAMESPACE","INDEX_DATA_SHAPE","INDEX_DEADLINE","INDEX_FINAL_EFFECT","INDEX_FIXTURE_BASE_DATA","INDEX_FIXTURE_CONSTRUCTION_LIMIT","INDEX_FIXTURE_SELECTION","INDEX_FIXTURE_SNAPSHOT_DATA","INDEX_FIXTURE_TRIAL_ID","INDEX_HELPER_EXPORT","INDEX_HELPER_EXPORTS","INDEX_HELPER_IMPORT_COUNT","INDEX_HELPER_SELECTION","INDEX_INPUT_EXECUTION","INDEX_INPUT_MUTATION","INDEX_KEY_DUPLICATE","INDEX_LOADER_CLOSED","INDEX_LOADER_DRIFT","INDEX_MATRIX_INCOMPLETE","INDEX_MATRIX_PORTS","INDEX_METADATA_BATCH","INDEX_METADATA_CURSOR","INDEX_METADATA_DATA","INDEX_METADATA_LIMIT","INDEX_METADATA_REPLY","INDEX_MODULE_PATHS","INDEX_MUTANT_INCOMPLETE","INDEX_MUTANT_NOT_DETECTED","INDEX_MUTANT_SET","INDEX_MUTANT_TRIAL_COUNTS","INDEX_MUTANT_TRIAL_SET","INDEX_MUTANT_UNRELATED_FAILURE","INDEX_NAME_DUPLICATE","INDEX_NESTED_IMPORT","INDEX_OPERATION_ATTEMPT","INDEX_OTHER_CACHE_DRIFT","INDEX_OVERRIDE_STATE","INDEX_OWNED_HANDLES","INDEX_PARENT_CHILDREN","INDEX_PORT_DRIFT","INDEX_PREEXISTING_HELPER","INDEX_PURE_EFFECT","INDEX_RESULT_MISMATCH","INDEX_RESULT_MUTATION","INDEX_RESULT_SHAPE","INDEX_ROW_LIMIT","INDEX_SCALAR_LONG","INDEX_SELECTION","INDEX_SENSITIVITY_INCOMPLETE","INDEX_SESSION","INDEX_SOURCE_BINDING","INDEX_TAP_DRIFT","INDEX_TAP_MISSING","INDEX_TAP_RESTORATION","INDEX_TRIAL_COUNTS","INDEX_TRIAL_DUPLICATE","INDEX_TRIAL_SET","INDEX_TYPE_REPORT","INDEX_UNDECLARED_COMMAND"]);
// Fixed selected-index fixture policy. The application comparator contains no policy copy.
const INDEX_ALIAS = '@/modules/common/utils/indexReadiness';
const INDEX_SOURCE = 'src1/modules/common/utils/indexReadiness.ts';
const INDEX_SOURCE_SHA = '050ecc993c862638cf4912bb854e04baa5d80241cb124e7831fc3c95a78db5bd';
const INDEX_MANIFEST_SHA = '9160db1c3e937f49f6a68cb87d5c55b2c9e0f662310b560f874a4d4a7f61e3c7';
const INDEX_MODE = 'MONGODB_8_INCLUDE_INDEX_BUILD_INFO';
const INDEX_CASE_IDS = Object.freeze(REQUIRED_CASE_IDS.slice(76));
const INDEX_MUTANT_IDS = Object.freeze(REQUIRED_SENSITIVITY_IDS.slice(21));
const INDEX_COLLECTIONS = Object.freeze(["users","admins","hrs","corporates","specialists","pharmacies","OTP","wallets","wallettransactions","notifications","fcmtokens","wellnesspackages","dependents"]);
const INDEX_MUTANTS = Object.freeze({"INDEX_MISSING_REQUIREMENT_ACCEPTED":{"sourceSha":"38840d330b825e2feb7240b73845ca11728cf516f4853d89e6e5e6d3ce6438f6","trials":["REMOVE_ID_00","REMOVE_ID_01","REMOVE_ID_02","REMOVE_ID_03","REMOVE_ID_04","REMOVE_ID_05","REMOVE_ID_06","REMOVE_ID_07","REMOVE_ID_08","REMOVE_ID_09","REMOVE_ID_10","REMOVE_ID_11","REMOVE_ID_12","REMOVE_EXPLICIT_00","REMOVE_EXPLICIT_02","REMOVE_EXPLICIT_05","REMOVE_EXPLICIT_06","REMOVE_EXPLICIT_07","REMOVE_EXPLICIT_08","REMOVE_EXPLICIT_09","REMOVE_EXPLICIT_10"]},"INDEX_KEY_ORDER_IGNORED":{"sourceSha":"03cedbf95c229c2bcacb4aa5913bc6b723b6dcaab10cab24d9dfd68278cca2d9","trials":["KEY_COMPOUND_REVERSED"]},"INDEX_OPTIONS_IGNORED":{"sourceSha":"cba386c2e53905dc8ef137d33a03c9ddc6841456addcf18d4539854664b1ad9c","trials":["ID_EXPLICIT_NONUNIQUE","UNIQUE_FALSE_00","UNIQUE_ABSENT_00","UNIQUE_FALSE_02","UNIQUE_ABSENT_02","UNIQUE_FALSE_05","UNIQUE_ABSENT_05","UNIQUE_FALSE_07","UNIQUE_ABSENT_07","UNIQUE_FALSE_08","UNIQUE_ABSENT_08","UNIQUE_FALSE_09","UNIQUE_ABSENT_09","UNIQUE_FALSE_10","UNIQUE_ABSENT_10","SPARSE_FALSE","SPARSE_ABSENT","TTL_ABSENT","TTL_ONE","TTL_UNEXPECTED","ID_TTL_UNEXPECTED","HIDDEN_REQUIRED"]},"INDEX_PARTIAL_FILTER_IGNORED":{"sourceSha":"37cc8f34866d598d7c2474627992c35eaf0e2fb3949386fc0bc0c22bd9bddb40","trials":["PARTIAL_EMPTY","PARTIAL_REFUND_VALUE","PARTIAL_REFERENCE_VALUE","PARTIAL_EXISTS","PARTIAL_TYPE_ALIAS","PARTIAL_EQ_FORM","PARTIAL_ARRAY_ORDER","PARTIAL_SCALAR_TYPE"]},"INDEX_INCOMPLETE_ACCEPTED":{"sourceSha":"be8b32e10a16334d68b8df8cfa0b55d5ffbaf161d826261366f6adbc8a8ab150","trials":["STATUS_INCOMPLETE"]},"INDEX_BUILD_STATUS_IGNORED":{"sourceSha":"a72e944ce170bbc8d6b68ce19ec2628bbfc4d86ba19be24e0aa19e219710104c","trials":["MARKER_WRAPPER_indexBuildInfo_NULL","MARKER_WRAPPER_indexBuildInfo_FALSE","MARKER_WRAPPER_indexBuildInfo_EMPTY","MARKER_WRAPPER_indexBuildInfo_CYCLE","MARKER_WRAPPER_indexBuildInfo_DRIVER_UUID","MARKER_WRAPPER_buildUUID_NULL","MARKER_WRAPPER_buildUUID_FALSE","MARKER_WRAPPER_buildUUID_EMPTY","MARKER_WRAPPER_buildUUID_CYCLE","MARKER_WRAPPER_buildUUID_DRIVER_UUID","MARKER_SPEC_indexBuildInfo_NULL","MARKER_SPEC_indexBuildInfo_FALSE","MARKER_SPEC_indexBuildInfo_EMPTY","MARKER_SPEC_indexBuildInfo_CYCLE","MARKER_SPEC_indexBuildInfo_DRIVER_UUID","MARKER_SPEC_buildUUID_NULL","MARKER_SPEC_buildUUID_FALSE","MARKER_SPEC_buildUUID_EMPTY","MARKER_SPEC_buildUUID_CYCLE","MARKER_SPEC_buildUUID_DRIVER_UUID","BUILDING_EXTRA","BUILDING_BEFORE_REQUIREMENT"]}});
const INDEX_TRIALS = Object.freeze([
  Object.freeze(["REAL_COMPLETE_SELECTED","INDEX_SELECTED_READBACK",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["REMOVE_ID_00","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_01","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":1,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_02","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":2,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_03","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":3,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_04","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":4,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_05","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":5,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_06","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":6,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_07","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":7,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_08","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_09","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":9,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_10","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":10,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_11","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":11,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_ID_12","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":12,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["REMOVE_EXPLICIT_00","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["REMOVE_EXPLICIT_02","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":2,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["REMOVE_EXPLICIT_05","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":5,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["REMOVE_EXPLICIT_06","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":6,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["REMOVE_EXPLICIT_07","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":7,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["REMOVE_EXPLICIT_08","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["REMOVE_EXPLICIT_09","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":9,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["REMOVE_EXPLICIT_10","INDEX_REQUIRED_REMOVAL_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":10,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_COMPOUND_REVERSED","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_NAME_0","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_DIRECTION_0","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_DROP_0","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_NAME_1","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_DIRECTION_1","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_DROP_1","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_NAME_2","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_DIRECTION_2","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_DROP_2","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_NAME_3","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_DIRECTION_3","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_DROP_3","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_EXTRA","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["KEY_DUPLICATE_FIELD","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["KEY_ZERO_DIRECTION","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["KEY_STRING_DIRECTION","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["KEY_BOOLEAN_DIRECTION","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["ID_WRONG_NAME","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["ID_WRONG_KEY","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["ID_EXPLICIT_NONUNIQUE","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["NONID_ABSENT_UNIQUE","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["COLLECTION_CASE","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["COLLECTION_MISSING","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["COLLECTION_FOREIGN","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["LISTING_DUPLICATE","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["INDEX_NAME_DUPLICATE","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["INDEX_KEY_DUPLICATE","INDEX_KEY_AND_IDENTITY_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["UNIQUE_FALSE_00","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_ABSENT_00","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_FALSE_02","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":2,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_ABSENT_02","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":2,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_FALSE_05","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":5,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_ABSENT_05","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":5,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_FALSE_07","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":7,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_ABSENT_07","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":7,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_FALSE_08","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_ABSENT_08","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_FALSE_09","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":9,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_ABSENT_09","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":9,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_FALSE_10","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":10,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["UNIQUE_ABSENT_10","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":10,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["SPARSE_FALSE","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["SPARSE_ABSENT","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["TTL_ABSENT","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":6,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["TTL_ONE","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":6,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["TTL_UNEXPECTED","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":7,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["ID_TTL_UNEXPECTED","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["TTL_INVALID_NEGATIVE","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["TTL_INVALID_FRACTION","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["TTL_INVALID_STRING","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["TTL_INVALID_NAN","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["TTL_INVALID_INFINITY","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["TTL_INVALID_TOO_LARGE","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["HIDDEN_REQUIRED","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":7,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["PARTIAL_ABSENT_8","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["PARTIAL_ABSENT_9","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":9,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["PARTIAL_EMPTY","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["PARTIAL_REFUND_VALUE","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["PARTIAL_REFERENCE_VALUE","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["PARTIAL_EXISTS","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["PARTIAL_TYPE_ALIAS","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["PARTIAL_EQ_FORM","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":8,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["PARTIAL_ARRAY_ORDER","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["PARTIAL_SCALAR_TYPE","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":1},"BOTH"]),
  Object.freeze(["COLLATION_NON_SIMPLE","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"OBSERVATION_UNSUPPORTED","collectionOrdinal":7,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["COLLATION_EXTRA","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"OBSERVATION_UNSUPPORTED","collectionOrdinal":7,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["COLLATION_NOT_OBJECT","INDEX_OPTIONS_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["STATUS_FAILED","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_FAILED","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["STATUS_INCOMPLETE","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_INCOMPLETE","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["STATUS_PARTIAL_NONEMPTY","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MODE_WRONG","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNSUPPORTED","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MODE_NOT_STRING","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["BARE_SPEC","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNSUPPORTED","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["WRAPPER_UNKNOWN","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNSUPPORTED","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["SPEC_UNKNOWN","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNSUPPORTED","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["EXTRA_UNKNOWN","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNSUPPORTED","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_WRAPPER_indexBuildInfo_NULL","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_WRAPPER_indexBuildInfo_FALSE","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_WRAPPER_indexBuildInfo_EMPTY","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_WRAPPER_indexBuildInfo_CYCLE","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_WRAPPER_indexBuildInfo_DRIVER_UUID","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_WRAPPER_buildUUID_NULL","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_WRAPPER_buildUUID_FALSE","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_WRAPPER_buildUUID_EMPTY","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_WRAPPER_buildUUID_CYCLE","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_WRAPPER_buildUUID_DRIVER_UUID","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_SPEC_indexBuildInfo_NULL","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_SPEC_indexBuildInfo_FALSE","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_SPEC_indexBuildInfo_EMPTY","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_SPEC_indexBuildInfo_CYCLE","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_SPEC_indexBuildInfo_DRIVER_UUID","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_SPEC_buildUUID_NULL","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_SPEC_buildUUID_FALSE","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_SPEC_buildUUID_EMPTY","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_SPEC_buildUUID_CYCLE","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_SPEC_buildUUID_DRIVER_UUID","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["BUILDING_EXTRA","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["UNSUPPORTED_BEFORE_BUILDING","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNSUPPORTED","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MARKER_GETTER","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["SPEC_GETTER","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["GLOBAL_SHAPE_BEFORE_FAILED","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["FAILED_BEFORE_LATER_UNSUPPORTED","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_FAILED","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["EARLIER_REQUIREMENT_BEFORE_LATER_FAILED","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"REQUIRED_INDEX_UNSATISFIED","collectionOrdinal":0,"indexOrdinal":0},"BOTH"]),
  Object.freeze(["MODE_BEFORE_BUILDING","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNSUPPORTED","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["BUILDING_BEFORE_REQUIREMENT","INDEX_OBSERVATION_DENIALS",{"ready":false,"code":"OBSERVATION_UNREADY","collectionOrdinal":0,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_EMPTY","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_UNKNOWN","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_DUPLICATE_COLLECTION","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_DUPLICATE_KEY","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_EXPLICIT_ID","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_ID_COMPOUND","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_COLLECTION_LIMIT","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_INDEX_LIMIT","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_COLLATION","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_GETTER","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["BOTH_INPUTS_INVALID","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["MANIFEST_BUDGET","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"MANIFEST_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_NULL","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_HOLE","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_ARRAY_EXTRA","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_SYMBOL","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_GETTER","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_FUNCTION","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_UNDEFINED","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_NAN","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_NATIVE_LONG","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_CYCLE","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["PARTIAL_DEPTH_7","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["KEY_LIMIT","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["NAME_LIMIT","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_STRING_BUDGET","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_NODE_BUDGET","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_COLLECTION_SPEC_LIMIT","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBS_TOTAL_SPEC_LIMIT","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"OBSERVATIONS_INVALID","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["REFLECTION_THROW","INDEX_INPUT_ADMISSION_DENIALS",{"ready":false,"code":"INPUT_INVALID","collectionOrdinal":null,"indexOrdinal":null},"ONE"]),
  Object.freeze(["NONID_RENAMED","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["HARMLESS_EXTRA","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["HIDDEN_EXTRA","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["ID_UNIQUE_ABSENT","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["EXPLICIT_FALSE_DEFAULTS","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["SIMPLE_COLLATION","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["OBSERVATION_ORDER","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["PARTIAL_KEY_ORDER","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["REPEATED_ALIAS","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["PARTIAL_QUERY_DATA_NAMES","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["PARTIAL_DEPTH_6","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["PROJECT_LONG_TTL","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["PROJECT_LONG_VERSION","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"]),
  Object.freeze(["PROJECT_LONG_DIRECTION","INDEX_IMMUTABILITY_AND_SAFE_RESULT",{"ready":true,"code":"READY","collectionOrdinal":null,"indexOrdinal":null},"BOTH"])
]);
const MODEL_IDENTITIES = Object.freeze({
  "User": [
    "users",
    "src1/modules/user/model/index.ts"
  ],
  "Admin": [
    "admins",
    "src1/modules/admin/model/index.ts"
  ],
  "HR": [
    "hrs",
    "src1/modules/hr/model/index.ts"
  ],
  "Corporate": [
    "corporates",
    "src1/modules/corporates/model/index.ts"
  ],
  "Specialist": [
    "specialists",
    "src1/modules/specialists/model/index.ts"
  ],
  "Pharmacy": [
    "pharmacies",
    "src1/modules/pharmacies/model/index.ts"
  ],
  "OTP": [
    "OTP",
    "src1/modules/otp/model/index.ts"
  ],
  "Wallet": [
    "wallets",
    "src1/modules/wallet/model/index.ts"
  ],
  "WalletTransaction": [
    "wallettransactions",
    "src1/modules/wallet/model/index.ts"
  ],
  "Notification": [
    "notifications",
    "src1/modules/notification/model/index.ts"
  ],
  "FcmToken": [
    "fcmtokens",
    "src1/modules/fcm/model/index.ts"
  ],
  "WellnessPackage": [
    "wellnesspackages",
    "src1/modules/wellnessPackages/model/index.ts"
  ],
  "Dependent": [
    "dependents",
    "src1/modules/dependents/model/index.ts"
  ]
});

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { const error = new Error(code); error.fixtureCode = code; throw error; };
const need = (ok, code) => { if (!ok) fail(code); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stdout = process.stdout.write.bind(process.stdout);
let stage = 'ADMISSION';
const counters = { email: 0, sms: 0, push: 0, logger: 0, console: 0, unexpected: 0, excluded: 0, jwtIssued: 0, dbWrites: 0, calendar: 0 };
for (const name of ['log', 'info', 'debug', 'warn', 'error']) console[name] = () => { counters.console++; };
process.emitWarning = () => { counters.console++; };

// Public literals only: no driver message, URI, path, row or validation fields.
const SETUP_FAILURE_CODES = Object.freeze({
  CONNECT: Object.freeze({
    PERMISSION: 'DB_CONNECT_PERMISSION', SELECTION: 'DB_CONNECT_SELECTION',
    NETWORK: 'DB_CONNECT_NETWORK', SERVER: 'DB_CONNECT_SERVER', TYPE_ERROR: 'DB_CONNECT_TYPE_ERROR',
    DUPLICATE_KEY: 'DB_CONNECT_DUPLICATE_KEY', NAMESPACE_EXISTS: 'DB_CONNECT_NAMESPACE_EXISTS',
    INDEX_CONFLICT: 'DB_CONNECT_INDEX_CONFLICT',
    OUT_OF_DISK_SPACE: 'DB_CONNECT_OUT_OF_DISK_SPACE', CANNOT_CREATE_INDEX: 'DB_CONNECT_CANNOT_CREATE_INDEX',
    INVALID_OPTIONS: 'DB_CONNECT_INVALID_OPTIONS', UNKNOWN: 'DB_CONNECT_UNKNOWN',
  }),
  HELLO: Object.freeze({
    PERMISSION: 'DB_HELLO_PERMISSION', SELECTION: 'DB_HELLO_SELECTION',
    NETWORK: 'DB_HELLO_NETWORK', SERVER: 'DB_HELLO_SERVER', TYPE_ERROR: 'DB_HELLO_TYPE_ERROR',
    DUPLICATE_KEY: 'DB_HELLO_DUPLICATE_KEY', NAMESPACE_EXISTS: 'DB_HELLO_NAMESPACE_EXISTS',
    INDEX_CONFLICT: 'DB_HELLO_INDEX_CONFLICT',
    OUT_OF_DISK_SPACE: 'DB_HELLO_OUT_OF_DISK_SPACE', CANNOT_CREATE_INDEX: 'DB_HELLO_CANNOT_CREATE_INDEX',
    INVALID_OPTIONS: 'DB_HELLO_INVALID_OPTIONS', UNKNOWN: 'DB_HELLO_UNKNOWN',
  }),
  COLLECTION_CREATE: Object.freeze({
    PERMISSION: 'DB_COLLECTION_CREATE_PERMISSION', SELECTION: 'DB_COLLECTION_CREATE_SELECTION',
    NETWORK: 'DB_COLLECTION_CREATE_NETWORK', SERVER: 'DB_COLLECTION_CREATE_SERVER', TYPE_ERROR: 'DB_COLLECTION_CREATE_TYPE_ERROR',
    DUPLICATE_KEY: 'DB_COLLECTION_CREATE_DUPLICATE_KEY', NAMESPACE_EXISTS: 'DB_COLLECTION_CREATE_NAMESPACE_EXISTS',
    INDEX_CONFLICT: 'DB_COLLECTION_CREATE_INDEX_CONFLICT',
    OUT_OF_DISK_SPACE: 'DB_COLLECTION_CREATE_OUT_OF_DISK_SPACE', CANNOT_CREATE_INDEX: 'DB_COLLECTION_CREATE_CANNOT_CREATE_INDEX',
    INVALID_OPTIONS: 'DB_COLLECTION_CREATE_INVALID_OPTIONS', UNKNOWN: 'DB_COLLECTION_CREATE_UNKNOWN',
  }),
  INDEX_CREATE: Object.freeze({
    PERMISSION: 'DB_INDEX_CREATE_PERMISSION', SELECTION: 'DB_INDEX_CREATE_SELECTION',
    NETWORK: 'DB_INDEX_CREATE_NETWORK', SERVER: 'DB_INDEX_CREATE_SERVER', TYPE_ERROR: 'DB_INDEX_CREATE_TYPE_ERROR',
    DUPLICATE_KEY: 'DB_INDEX_CREATE_DUPLICATE_KEY', NAMESPACE_EXISTS: 'DB_INDEX_CREATE_NAMESPACE_EXISTS',
    INDEX_CONFLICT: 'DB_INDEX_CREATE_INDEX_CONFLICT',
    OUT_OF_DISK_SPACE: 'DB_INDEX_CREATE_OUT_OF_DISK_SPACE', CANNOT_CREATE_INDEX: 'DB_INDEX_CREATE_CANNOT_CREATE_INDEX',
    INVALID_OPTIONS: 'DB_INDEX_CREATE_INVALID_OPTIONS', UNKNOWN: 'DB_INDEX_CREATE_UNKNOWN',
  }),
});
const SETUP_GUARD_CODES = new Set([
  'UNDECLARED_DATABASE_URI', 'EXTRA_DATABASE_CONNECTION', 'OTHER_DATABASE_NAME',
  'UNDECLARED_DRIVER_URI', 'OTHER_DRIVER_DATABASE', 'UNDECLARED_COLLECTION',
  'UNDECLARED_COLLECTION_CREATE', 'UNDECLARED_NETWORK_CONNECTION', 'TLS_NOT_ADMITTED',
  'DNS_NOT_ADMITTED', 'DENIED_BUILTIN', 'UNDECLARED_DOMAIN_MODULE', 'UNDECLARED_PACKAGE_OR_FILE',
]);
const SETUP_ERROR_NAMES = new Set([
  'MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoNetworkError',
  'MongoNetworkTimeoutError', 'MongoServerError', 'MongoBulkWriteError',
  'MongoWriteConcernError', 'TypeError',
]);
const ownData = (value, key) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
};
function setupErrorName(value) {
  const own = ownData(value, 'name');
  if (SETUP_ERROR_NAMES.has(own)) return own;
  let prototype = value;
  for (let depth = 0; depth < 3; depth++) {
    try { prototype = Object.getPrototypeOf(prototype); } catch { return undefined; }
    if (!prototype) return undefined;
    const name = ownData(prototype, 'name');
    if (SETUP_ERROR_NAMES.has(name)) return name;
    const constructor = ownData(prototype, 'constructor');
    const constructorName = typeof constructor === 'function' ? ownData(constructor, 'name') : undefined;
    if (SETUP_ERROR_NAMES.has(constructorName)) return constructorName;
  }
  return undefined;
}
function setupFailure(error) {
  const chain = []; const seen = new Set(); let value = error;
  for (let depth = 0; depth < 3 && value !== null
    && ['object', 'function'].includes(typeof value) && !seen.has(value); depth++) {
    chain.push({ value, name: setupErrorName(value), code: ownData(value, 'code') });
    seen.add(value); value = ownData(value, 'cause');
  }
  for (const row of chain) {
    const guard = ownData(row.value, 'fixtureCode');
    if (SETUP_GUARD_CODES.has(guard)) return { guard };
  }
  if (chain.some(row => ['ERR_ACCESS_DENIED', 'EACCES', 'EPERM', 13, 18].includes(row.code))) return { category: 'PERMISSION' };
  if (chain.some(row => row.code === 11000)) return { category: 'DUPLICATE_KEY' };
  if (chain.some(row => row.code === 48)) return { category: 'NAMESPACE_EXISTS' };
  if (chain.some(row => [85, 86].includes(row.code))) return { category: 'INDEX_CONFLICT' };
  if (chain.some(row => row.code === 14031)) return { category: 'OUT_OF_DISK_SPACE' };
  if (chain.some(row => row.code === 67)) return { category: 'CANNOT_CREATE_INDEX' };
  if (chain.some(row => row.code === 72)) return { category: 'INVALID_OPTIONS' };
  if (chain.some(row => ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
    'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(row.code)
    || ['MongoNetworkError', 'MongoNetworkTimeoutError'].includes(row.name))) return { category: 'NETWORK' };
  if (chain.some(row => ['MongoServerSelectionError', 'MongooseServerSelectionError'].includes(row.name))) return { category: 'SELECTION' };
  if (chain.some(row => [26, 50, 91, 10107, 11600, 11602].includes(row.code)
    || ['MongoServerError', 'MongoBulkWriteError', 'MongoWriteConcernError'].includes(row.name))) return { category: 'SERVER' };
  if (chain.some(row => row.name === 'TypeError')) return { category: 'TYPE_ERROR' };
  return { category: 'UNKNOWN' };
}
async function runSetupStep(step, action) {
  need(typeof step === 'string' && Object.hasOwn(SETUP_FAILURE_CODES, step) && typeof action === 'function', 'UNDECLARED_SETUP_STEP');
  try { return await action(); } catch (error) {
    const classification = setupFailure(error);
    const code = classification.guard || SETUP_FAILURE_CODES[step][classification.category];
    // Preserve the original thrown value only as a non-enumerable memory cause.
    // The existing seven-field output sees a fresh safe Error, no raw metadata.
    const wrapped = new Error(code, { cause: error }); wrapped.fixtureCode = code; throw wrapped;
  }
}

async function withOwnedCleanup(action, closeHTTP, disconnectODM) {
  need(typeof action === 'function' && typeof closeHTTP === 'function'
    && typeof disconnectODM === 'function', 'INVALID_OWNED_CLEANUP_PORTS');
  let result; let primary; let failed = false;
  try { result = await action(); } catch (error) { primary = error; failed = true; }
  const failures = [];
  for (const [step, close] of [['HTTP', closeHTTP], ['ODM', disconnectODM]]) {
    try { await close(); } catch (error) { failures.push(Object.freeze({ step, error })); }
  }
  function retainPrivately(error) {
    if (error !== null && ['object', 'function'].includes(typeof error) && failures.length) {
      try { Object.defineProperty(error, 'ownedCleanupFailures', { value: Object.freeze(failures) }); } catch {}
    }
    return error;
  }
  if (failed) throw retainPrivately(primary);
  if (failures.length) {
    const error = new Error('OWNED_HANDLE_CLEANUP_FAILED', { cause: failures[0].error });
    error.fixtureCode = 'OWNED_HANDLE_CLEANUP_FAILED'; throw retainPrivately(error);
  }
  return result;
}

function bytes(relative) {
  need(typeof relative === 'string' && relative !== '' && !relative.startsWith('/')
    && !relative.split('/').includes('..') && !relative.includes('\\'), 'BAD_RELATIVE_PATH');
  const p = path.join(ROOT, relative); const m = fs.lstatSync(p);
  need(m.isFile() && !m.isSymbolicLink() && m.nlink === 1, 'NONREGULAR_RUNTIME_FILE');
  return fs.readFileSync(p);
}

function validateAdmissionData(manifest, plan, ports, observed) {
  need(plain(manifest) && manifest.schema === 'SD-AUTH-API-RUN-1' && manifest.role === ROLE, 'RUN_MANIFEST_SCHEMA');
  need(/^[a-f0-9-]{36}$/.test(manifest.runId) && manifest.runId === observed.runId, 'RUN_ID');
  const nonce = manifest.runId.replaceAll('-', '');
  need(manifest.database === 'sd_api_' + nonce && manifest.replicaSet === 'sd_rs_' + nonce, 'DATABASE_IDENTITY');
  need(/^[a-f0-9]{64}$/.test(manifest.mongoId) && /^[a-f0-9]{64}$/.test(manifest.templateSha)
    && /^[a-f0-9]{40}$/.test(manifest.sourceCommit), 'RESOURCE_IDENTITY');
  need(plain(manifest.files) && Object.keys(manifest.files).length > 5 && Object.keys(manifest.files).length <= 20000
    && plain(observed.files), 'FILE_MANIFEST');
  need(JSON.stringify(Object.keys(observed.files).sort()) === JSON.stringify(Object.keys(manifest.files).sort()), 'RUNTIME_FILE_SET');
  let size = 0;
  for (const [name, data] of Object.entries(observed.files)) {
    need(Buffer.isBuffer(data) && /^[a-f0-9]{64}$/.test(manifest.files[name])
      && sha(data) === manifest.files[name], 'RUNTIME_FILE_HASH'); size += data.length;
  }
  need(size <= 256 * 1024 * 1024, 'RUNTIME_FILE_LIMIT');
  need(['bootstrap.cjs', 'scenario.cjs', 'network-admission.mjs', 'runtime-plan.json', 'ports-manifest.json', 'package-lock.json']
    .every(name => Buffer.isBuffer(observed.files[name])), 'MISSING_RUNTIME_INPUT');
  need(manifest.lockSha === sha(observed.files['package-lock.json'])
    && manifest.portsSha === sha(observed.files['ports-manifest.json']), 'LOCK_PORT_HASH');
  need(plan.schema === 'SD-AUTH-API-PLAN-1' && plan.role === ROLE && plan.sourceCommit === manifest.sourceCommit
    && plan.lockSha === manifest.lockSha && plan.portsSha === manifest.portsSha, 'PLAN_IDENTITY');
  need(plan.compilation.status === 'TRANSPILE_ONLY_NOT_TYPECHECKED' && plan.compilation.compiler === '5.9.3', 'COMPILATION_STATUS');
  need(ports.schema === 'SD-AUTH-API-PORTS-1' && ports.role === ROLE
    && JSON.stringify(plan.requiredCaseIds) === JSON.stringify(ports.requiredCaseIds)
    && JSON.stringify(plan.requiredSensitivityIds) === JSON.stringify(ports.requiredSensitivityIds)
    && JSON.stringify(plan.providerCounterKeys) === JSON.stringify(ports.providerCounterKeys)
    && JSON.stringify(plan.models) === JSON.stringify(ports.models), 'PORT_CONTRACT');
  need(JSON.stringify(ports.roots) === JSON.stringify(ADMITTED_ROOTS)
    && JSON.stringify(ports.requiredCaseIds) === JSON.stringify(REQUIRED_CASE_IDS)
    && JSON.stringify(ports.requiredSensitivityIds) === JSON.stringify(REQUIRED_SENSITIVITY_IDS), 'AUTHORITY_PLAN');
  need(Array.isArray(ports.requiredCaseIds) && ports.requiredCaseIds.length >= 20
    && new Set(ports.requiredCaseIds).size === ports.requiredCaseIds.length, 'CASE_SET');
  need(JSON.stringify(ports.recordingModules) === JSON.stringify(['@/services/logger', '@/services/firebase'])
    && JSON.stringify(ports.excludedCapabilities) === JSON.stringify({ '@/modules/payment/services': ['PaymentService'], '@/modules/coupon/services': ['CouponService'] })
    && ports.recordingAxios.email === 'https://api.smtp2go.com/v3/email/send'
    && ports.recordingAxios.sms === 'https://sms.fixture.invalid/send', 'RECORDING_PORT_MAP');
  need(meetSame(meetData(ports.recordingMeet), MEET_RECORDING), 'MEET_RECORDING_MAP');
  need(plain(plan.modules) && plain(plan.mutants) && plain(plan.sourceFiles)
    && Object.keys(plan.sourceFiles).length > 0 && Object.values(plan.sourceFiles).every(value => /^[a-f0-9]{64}$/.test(value)), 'SOURCE_MANIFEST');
  for (const file of Object.values(plan.modules)) need(Object.hasOwn(manifest.files, file), 'UNDECLARED_COMPILED_SOURCE');
  for (const alias of ports.roots) need(Object.hasOwn(plan.modules, alias), 'MISSING_ROUTER_SOURCE');
  for (const mutant of Object.values(plan.mutants)) need(Object.hasOwn(manifest.files, mutant.file)
    && mutant.originalSha256 === plan.sourceFiles[mutant.source], 'UNDECLARED_MUTANT');
  need(plan.modules[CONFIG_ALIAS] === 'compiled/config/config.js'
    && Object.hasOwn(plan.sourceFiles, 'src1/config/config.ts')
    && CONFIG_MUTANT_IDS.every(id => plan.mutants[id]?.source === 'src1/config/config.ts'
      && plan.mutants[id].file === 'compiled/mutants/' + id + '.js'), 'CONFIG_SOURCE_BINDING');
  need(plan.modules['@/modules/meet/routes'] === 'compiled/modules/meet/routes/index.js'
    && ['routes', 'controller', 'validation', 'service', 'types'].every(name =>
      Object.hasOwn(plan.sourceFiles, 'src1/modules/meet/' + name + '/index.ts'))
    && REQUIRED_SENSITIVITY_IDS.slice(17, 21).every(id => plan.mutants[id]?.source === 'src1/modules/meet/routes/index.ts'
      && plan.mutants[id].file === 'compiled/mutants/' + id + '.js'), 'MEET_SOURCE_BINDING');
  need(plan.modules[INDEX_ALIAS] === 'compiled/modules/common/utils/indexReadiness.js'
    && plan.sourceFiles[INDEX_SOURCE] === INDEX_SOURCE_SHA
    && INDEX_MUTANT_IDS.every(id => plan.mutants[id]?.source === INDEX_SOURCE
      && plan.mutants[id].originalSha256 === INDEX_SOURCE_SHA
      && plan.mutants[id].mutantSha256 === INDEX_MUTANTS[id].sourceSha
      && plan.mutants[id].file === 'compiled/mutants/' + id + '.js'), 'INDEX_SOURCE_BINDING');
  validateIndexTypeReport(plan.compilation.selectedHelperTypecheck);
  need(Array.isArray(ports.models) && ports.models.length === 13
    && new Set(ports.models.map(row => row.name)).size === 13
    && new Set(ports.models.map(row => row.collection)).size === 13
    && ports.models.every(row => plain(row) && typeof row.name === 'string' && Object.hasOwn(MODEL_IDENTITIES, row.name)
      && JSON.stringify(MODEL_IDENTITIES[row.name]) === JSON.stringify([row.collection, row.source])
      && Object.hasOwn(plan.sourceFiles, row.source) && Array.isArray(row.indexes)), 'MODEL_MAP');
  return manifest;
}

function inspectManifest(manifest, plan, ports) {
  const observed = {}; let size = 0;
  function walk(directory, prefix = '') {
    for (const name of fs.readdirSync(directory)) {
      const relative = prefix + name; const p = path.join(directory, name); const m = fs.lstatSync(p);
      need(!m.isSymbolicLink(), 'RUNTIME_LINK');
      if (m.isDirectory()) walk(p, relative + '/');
      else {
        need(m.isFile() && m.nlink === 1 && !name.endsWith('.node') && !name.startsWith('.env'), 'RUNTIME_FILE_TYPE');
        if (relative === '.admission.json') continue;
        size += m.size; need(size <= 256 * 1024 * 1024 && Object.keys(observed).length < 20000, 'RUNTIME_FILE_LIMIT');
        observed[relative] = fs.readFileSync(p);
      }
    }
  }
  walk(ROOT);
  return validateAdmissionData(manifest, plan, ports, { runId: process.env.APP_RUN_ID, files: observed });
}

function closeNetwork() {
  const httpPorts = new Set();
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let value = args[0];
    if (Array.isArray(value)) value = value[0];
    const options = plain(value) ? value : { port: value, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    const host = options.host || 'localhost'; const port = Number(options.port);
    if (options.path || !['127.0.0.1', 'localhost', '::1'].includes(host)
      || !Number.isInteger(port) || !(port === 27017 || httpPorts.has(port))) {
      counters.unexpected++; fail('UNDECLARED_NETWORK_CONNECTION');
    }
    return original.apply(this, args);
  };
  tls.connect = () => { counters.unexpected++; fail('TLS_NOT_ADMITTED'); };
  const lookup = dns.lookup;
  dns.lookup = (host, ...args) => {
    need(['localhost', '127.0.0.1', '::1'].includes(host), 'DNS_NOT_ADMITTED');
    return lookup.call(dns, host, ...args);
  };
  for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveSrv', 'resolveTxt', 'reverse']) {
    dns[name] = () => { counters.unexpected++; fail('DNS_NOT_ADMITTED'); };
  }
  return httpPorts;
}

function installLoader(manifest, plan, ports) {
  const originalResolve = Module._resolveFilename;
  const originalLoad = Module._load;
  const builtins = new Set(Module.builtinModules.map(name => name.replace(/^node:/, '')));
  const deniedBuiltins = new Set(['child_process', 'worker_threads', 'vm', 'inspector', 'repl', 'module']);
  const optional = new Set(ports.optionalAbsentPackages);
  let substitutes = {}; let overrides = {};
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request.startsWith('@/')) {
      const relative = overrides[request] || plan.modules[request];
      need(relative && Object.hasOwn(manifest.files, relative), 'UNDECLARED_DOMAIN_MODULE');
      return path.join(ROOT, relative);
    }
    const builtin = request.replace(/^node:/, '');
    if (builtins.has(builtin)) {
      need(!deniedBuiltins.has(builtin), 'DENIED_BUILTIN');
      return originalResolve.call(this, request, parent, isMain, options);
    }
    if (optional.has(request)) { const error = new Error('Optional fixture package absent'); error.code = 'MODULE_NOT_FOUND'; throw error; }
    const filename = originalResolve.call(this, request, parent, isMain, options);
    const relative = path.relative(ROOT, filename).split(path.sep).join('/');
    need(!relative.startsWith('../') && Object.hasOwn(manifest.files, relative), 'UNDECLARED_PACKAGE_OR_FILE');
    return filename;
  };
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(substitutes, request)) return substitutes[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  return {
    phase(nextSubstitutes, nextOverrides = {}) {
      substitutes = nextSubstitutes; overrides = nextOverrides;
    },
    resetCompiled() {
      for (const filename of Object.keys(require.cache)) {
        if (filename.startsWith(ROOT + '/compiled/') && !filename.includes('/model/')) delete require.cache[filename];
      }
    },
    indexScope(attempts) {
      need(Object.keys(overrides).length === 0, 'INDEX_OVERRIDE_STATE');
      const heldSubstitutes = substitutes; const heldOverrides = overrides;
      const heldLoad = Module._load; const heldResolve = Module._resolveFilename;
      const relatives = [plan.modules[INDEX_ALIAS], ...INDEX_MUTANT_IDS.map(id => plan.mutants[id]?.file)];
      need(relatives[0] === 'compiled/modules/common/utils/indexReadiness.js'
        && relatives.every(relative => typeof relative === 'string' && Object.hasOwn(manifest.files, relative))
        && new Set(relatives).size === 7, 'INDEX_MODULE_PATHS');
      const paths = relatives.map(relative => path.join(ROOT, relative));
      need(paths.every(filename => !Object.hasOwn(require.cache, filename)), 'INDEX_PREEXISTING_HELPER');
      const heldCache = new Map(Object.entries(require.cache));
      const children = module.children; const childValues = children.slice(); let closed = false;
      function clear() {
        for (const filename of paths) delete require.cache[filename];
        need(module.children === children, 'INDEX_PARENT_CHILDREN');
        for (let i = children.length - 1; i >= 0; i--) if (paths.includes(children[i].filename)) children.splice(i, 1);
      }
      function checkOthers() {
        const others = Object.keys(require.cache).filter(filename => !paths.includes(filename));
        need(others.length === heldCache.size && others.every(filename => heldCache.get(filename) === require.cache[filename]), 'INDEX_OTHER_CACHE_DRIFT');
        need(module.children === children && children.length === childValues.length
          && children.every((value, i) => value === childValues[i]), 'INDEX_PARENT_CHILDREN');
        need(substitutes === heldSubstitutes && Module._resolveFilename === heldResolve, 'INDEX_LOADER_DRIFT');
      }
      return {
        load(id) {
          need(!closed && (id === null || INDEX_MUTANT_IDS.includes(id)), 'INDEX_HELPER_SELECTION');
          clear(); checkOthers();
          const relative = id === null ? relatives[0] : plan.mutants[id].file;
          overrides = { [INDEX_ALIAS]: relative }; let imports = 0;
          const trap = function (request, parent, isMain) {
            imports++;
            if (imports !== 1 || request !== INDEX_ALIAS || parent !== module) {
              attempts.import++; fail('INDEX_NESTED_IMPORT');
            }
            return heldLoad.call(this, request, parent, isMain);
          };
          return configurationFinally(() => {
            need(Module._load === heldLoad, 'INDEX_LOADER_DRIFT'); Module._load = trap;
            const exported = require(INDEX_ALIAS);
            need(imports === 1, 'INDEX_HELPER_IMPORT_COUNT');
            const values = indexObject(exported, ['__esModule', 'evaluateIndexReadiness'], ['__esModule', 'evaluateIndexReadiness'], 'INDEX_HELPER_EXPORTS');
            need(values.__esModule === true && typeof values.evaluateIndexReadiness === 'function', 'INDEX_HELPER_EXPORTS');
            attempts.loads++; return values.evaluateIndexReadiness;
          }, [() => {
            const unchanged = Module._load === trap; Module._load = heldLoad;
            overrides = heldOverrides; need(unchanged, 'INDEX_LOADER_DRIFT');
          }]);
        },
        restore() {
          need(!closed, 'INDEX_LOADER_CLOSED'); closed = true;
          return configurationFinally(() => { clear(); }, [() => {
            overrides = heldOverrides; substitutes = heldSubstitutes;
            need(Module._load === heldLoad && Module._resolveFilename === heldResolve, 'INDEX_LOADER_DRIFT');
            checkOthers(); need(paths.every(filename => !Object.hasOwn(require.cache, filename)), 'INDEX_CACHE_RESTORATION');
          }]);
        },
      };
    },
    load: name => require(name),
  };
}

// Safe telemetry counts only; event commands and cursor metadata are never retained.
function recordReadOperation(event, database, readOps, effectCounters) {
  if (event.databaseName !== database || !['find', 'aggregate', 'count', 'getMore'].includes(event.commandName)) return;
  let collection;
  try { collection = event.commandName === 'getMore' ? event.command?.collection : event.command?.[event.commandName]; } catch {}
  if (typeof collection !== 'string' || !Object.hasOwn(readOps, collection)
    || !Number.isSafeInteger(readOps[collection]) || readOps[collection] < 0 || readOps[collection] >= Number.MAX_SAFE_INTEGER) {
    effectCounters.unexpected++; return;
  }
  readOps[collection]++;
}

// Only private synthetic request copies survive the recorder. No SDK or provider is loaded.
function recordPush(payload, pushes, effectCounters) {
  effectCounters.push++;
  let captured;
  try {
    const keys = plain(payload) ? Object.keys(payload) : [];
    const notification = payload?.notification;
    const valid = keys.includes('tokens') && keys.includes('notification')
      && keys.every(key => ['tokens', 'notification', 'data'].includes(key))
      && Array.isArray(payload.tokens) && payload.tokens.length > 0 && payload.tokens.length <= 500
      && payload.tokens.every(token => typeof token === 'string' && token.length > 0)
      && plain(notification) && Object.keys(notification).length === 2
      && Object.hasOwn(notification, 'title') && Object.hasOwn(notification, 'body')
      && typeof notification.title === 'string' && typeof notification.body === 'string'
      && (payload.data === undefined || (plain(payload.data)
        && Object.values(payload.data).every(value => typeof value === 'string')));
    if (valid) captured = structuredClone(payload);
  } catch {}
  if (captured === undefined) { effectCounters.unexpected++; fail('UNDECLARED_PUSH_PAYLOAD'); }
  pushes.push(captured);
  return { successCount: 0, failureCount: 0, responses: [] };
}

// Fixed synthetic settings and a closed, nondelegating fetch boundary. The
// literals are independent of the supplied manifest and contain no real account.
const MEET_RECORDING = {
  "tokenUrl": "https://oauth2.googleapis.com/token",
  "calendarUrl": "https://www.googleapis.com/calendar/v3/calendars/fixture-calendar%40example.com/events?conferenceDataVersion=1&sendUpdates=all",
  "bodyBytes": 8192,
  "recordLimit": 256,
  "environment": {
    "GOOGLE_OAUTH_CLIENT_ID": "fixture-google-client-id",
    "GOOGLE_OAUTH_CLIENT_SECRET": "fixture-google-client-secret",
    "GOOGLE_OAUTH_REDIRECT_URI": "https://fixture.example.com/oauth/callback",
    "GOOGLE_OAUTH_REFRESH_TOKEN": "fixture-refresh-token",
    "GOOGLE_CALENDAR_ID": "fixture-calendar@example.com",
    "GOOGLE_MEET_TIMEZONE": "Asia/Kolkata"
  },
  "oauthResponse": {
    "access_token": "fixture-access-token-1234567890",
    "token_type": "Bearer",
    "expires_in": 3600,
    "refresh_token": "fixture-refresh-token"
  },
  "eventResponse": {
    "id": "fixture-event-id",
    "hangoutLink": "https://meet.google.com/abc-defg-hij",
    "conferenceData": {
      "conferenceId": "abc-defg-hij"
    }
  },
  "providerCounter": "calendar",
  "providerCounterScope": "ALL_NOMINAL_RECORDED_GOOGLE_TOKEN_AND_CALENDAR_REQUESTS_EXCLUDING_SENSITIVITY"
};

function meetObject(value, keys) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'MEET_RECORDING_DATA');
  const own = Reflect.ownKeys(value);
  need(own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)), 'MEET_RECORDING_DATA');
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'MEET_RECORDING_DATA');
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result;
}
function meetArray(value, limit) {
  need(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, 'MEET_RECORDING_DATA');
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  need(Number.isSafeInteger(length) && length >= 0 && length <= limit, 'MEET_RECORDING_DATA');
  const keys = Reflect.ownKeys(value);
  need(keys.length === length + 1 && keys.every(key => key === 'length'
    || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length)), 'MEET_RECORDING_DATA');
  const output = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    need(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'MEET_RECORDING_DATA');
    output.push(descriptor.value);
  }
  return output;
}
function meetData(value) {
  let nodes = 0; const seen = new Set();
  function copy(input, depth) {
    need(depth <= 16 && ++nodes <= 2048, 'MEET_RECORDING_DATA');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      need(Buffer.byteLength(input, 'utf8') <= 8192, 'MEET_RECORDING_DATA'); return input;
    }
    if (typeof input === 'number') { need(Number.isFinite(input), 'MEET_RECORDING_DATA'); return input; }
    need(input !== null && typeof input === 'object' && !seen.has(input), 'MEET_RECORDING_DATA'); seen.add(input);
    let result;
    if (Array.isArray(input)) result = meetArray(input, 256).map(item => copy(item, depth + 1));
    else {
      const keys = Reflect.ownKeys(input);
      need(keys.length <= 64 && keys.every(key => typeof key === 'string'
        && !['__proto__', 'constructor', 'prototype'].includes(key)), 'MEET_RECORDING_DATA');
      const own = meetObject(input, keys); result = {};
      for (const key of keys.sort()) Object.defineProperty(result, key,
        { value: copy(own[key], depth + 1), enumerable: true });
    }
    seen.delete(input); return Object.freeze(result);
  }
  const result = copy(value, 0);
  need(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 8192, 'MEET_RECORDING_DATA'); return result;
}
const meetSame = (left, right) => JSON.stringify(meetData(left)) === JSON.stringify(meetData(right));

function createMeetRecorder(spec, effects) {
  need(meetSame(spec, MEET_RECORDING), 'MEET_RECORDING_MAP');
  need(plain(effects) && Number.isSafeInteger(effects.calendar) && effects.calendar >= 0
    && Number.isSafeInteger(effects.unexpected) && effects.unexpected >= 0, 'MEET_RECORDING_COUNTERS');
  const settings = meetData(spec); const captures = []; let expected = [];
  const text = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= settings.bodyBytes;
  function guarded(code, action) {
    try { return action(); } catch {
      effects.unexpected++; fail(code);
    }
  }
  function descriptor(input) {
    const data = meetData(input);
    if (data?.kind === 'code') {
      meetObject(data, ['kind', 'code', 'redirectUri']);
      need(text(data.code) && data.redirectUri === settings.environment.GOOGLE_OAUTH_REDIRECT_URI, 'MEET_RECORDING_DATA');
    } else if (data?.kind === 'refresh') {
      meetObject(data, ['kind', 'refreshToken']);
      need(text(data.refreshToken), 'MEET_RECORDING_DATA');
    } else {
      meetObject(data, ['kind', 'payload']); need(data.kind === 'event', 'MEET_RECORDING_DATA');
      const payload = meetObject(data.payload, ['summary', 'description', 'start', 'end', 'attendees']);
      need(text(payload.summary) && text(payload.description), 'MEET_RECORDING_DATA');
      for (const value of [payload.start, payload.end]) {
        const date = meetObject(value, ['dateTime', 'timeZone']);
        need(typeof date.dateTime === 'string' && /^2030-01-15T(?:10:00|10:30):00$/.test(date.dateTime)
          && date.timeZone === settings.environment.GOOGLE_MEET_TIMEZONE, 'MEET_RECORDING_DATA');
      }
      const attendees = meetArray(payload.attendees, 2);
      need(attendees.length === 2, 'MEET_RECORDING_DATA');
      for (const attendee of attendees) {
        const row = meetObject(attendee, ['email']);
        need(typeof row.email === 'string' && /^[A-Za-z0-9._+-]+@example\.com$/.test(row.email), 'MEET_RECORDING_DATA');
      }
    }
    return data;
  }
  function expectMeetRequests(requests) {
    return guarded('MEET_RECORDING_QUEUE', () => {
      need(expected.length === 0, 'MEET_RECORDING_DATA');
      const values = meetArray(requests, settings.recordLimit);
      const next = values.map(descriptor);
      need(captures.length + next.length <= settings.recordLimit, 'MEET_RECORDING_DATA');
      expected = next;
    });
  }
  async function fetch(input, options) {
    return guarded('MEET_RECORDING_REQUEST', () => {
      need(expected.length > 0 && captures.length < settings.recordLimit
        && typeof input === 'string' && Buffer.byteLength(input, 'utf8') <= settings.bodyBytes, 'MEET_RECORDING_DATA');
      const request = meetObject(options, ['method', 'headers', 'body']);
      need(request.method === 'POST', 'MEET_RECORDING_DATA');
      const current = expected[0]; let body; let headers; let reply;
      if (current.kind === 'code' || current.kind === 'refresh') {
        need(input === settings.tokenUrl && Object.getPrototypeOf(request.body) === URLSearchParams.prototype, 'MEET_RECORDING_DATA');
        headers = meetData(request.headers);
        need(meetSame(headers, { 'Content-Type': 'application/x-www-form-urlencoded' }), 'MEET_RECORDING_DATA');
        const encoded = URLSearchParams.prototype.toString.call(request.body);
        need(Buffer.byteLength(encoded, 'utf8') <= settings.bodyBytes, 'MEET_RECORDING_DATA');
        const entries = [...URLSearchParams.prototype.entries.call(request.body)];
        need(new Set(entries.map(row => row[0])).size === entries.length, 'MEET_RECORDING_DATA');
        body = meetData(Object.fromEntries(entries));
        const credentials = { client_id: settings.environment.GOOGLE_OAUTH_CLIENT_ID,
          client_secret: settings.environment.GOOGLE_OAUTH_CLIENT_SECRET };
        const wanted = current.kind === 'code'
          ? { code: current.code, ...credentials, redirect_uri: current.redirectUri, grant_type: 'authorization_code' }
          : { ...credentials, refresh_token: current.refreshToken, grant_type: 'refresh_token' };
        need(meetSame(body, wanted), 'MEET_RECORDING_DATA'); reply = settings.oauthResponse;
      } else {
        need(input === settings.calendarUrl && typeof request.body === 'string'
          && Buffer.byteLength(request.body, 'utf8') <= settings.bodyBytes, 'MEET_RECORDING_DATA');
        headers = meetData(request.headers);
        need(meetSame(headers, { Authorization: 'Bearer ' + settings.oauthResponse.access_token,
          'Content-Type': 'application/json' }), 'MEET_RECORDING_DATA');
        body = meetData(JSON.parse(request.body));
        const event = meetObject(body, ['summary', 'description', 'start', 'end', 'attendees', 'conferenceData']);
        const conference = meetObject(event.conferenceData, ['createRequest']);
        const create = meetObject(conference.createRequest, ['requestId', 'conferenceSolutionKey']);
        need(typeof create.requestId === 'string' && /^meet-[0-9]+$/.test(create.requestId)
          && meetSame(create.conferenceSolutionKey, { type: 'hangoutsMeet' }), 'MEET_RECORDING_DATA');
        const { conferenceData, ...payload } = event;
        need(meetSame(payload, current.payload), 'MEET_RECORDING_DATA'); reply = settings.eventResponse;
      }
      const record = meetData({ kind: current.kind, method: 'POST', url: input, headers, body });
      const replyText = JSON.stringify(meetData(reply));
      need(Number.isSafeInteger(effects.calendar) && effects.calendar >= 0 && effects.calendar < Number.MAX_SAFE_INTEGER,
        'MEET_RECORDING_DATA');
      expected.shift(); captures.push(record); effects.calendar++;
      return Object.freeze({ ok: true, text: async () => replyText });
    });
  }
  return Object.freeze({ fetch, expectMeetRequests,
    get meetRequests() { return Object.freeze(captures.slice()); },
    assertDone() { return guarded('MEET_RECORDING_PENDING', () => need(expected.length === 0, 'MEET_RECORDING_DATA')); },
  });
}

function meetFetchLifecycle(target, spec, effects) {
  const held = Object.getOwnPropertyDescriptor(target, 'fetch');
  need(held && Object.hasOwn(held, 'value') && typeof held.value === 'function'
    && (held.writable || held.configurable), 'MEET_FETCH_PORT');
  let active; let closed = false;
  return Object.freeze({
    phase() {
      need(!closed, 'MEET_FETCH_CLOSED');
      const current = Object.getOwnPropertyDescriptor(target, 'fetch');
      need(current && current.value === (active ? active.fetch : held.value)
        && current.enumerable === held.enumerable && current.writable === held.writable
        && current.configurable === held.configurable, 'MEET_FETCH_DRIFT');
      if (active) active.assertDone();
      const next = createMeetRecorder(spec, effects);
      Object.defineProperty(target, 'fetch', { ...held, value: next.fetch }); active = next; return next;
    },
    restore() {
      need(!closed, 'MEET_FETCH_CLOSED'); closed = true;
      let first;
      try { active?.assertDone(); } catch (error) { first = error; }
      try {
        const current = Object.getOwnPropertyDescriptor(target, 'fetch');
        const unchanged = current && current.value === (active ? active.fetch : held.value)
          && current.enumerable === held.enumerable && current.writable === held.writable && current.configurable === held.configurable;
        Object.defineProperty(target, 'fetch', held);
        const restored = Object.getOwnPropertyDescriptor(target, 'fetch');
        need(restored.value === held.value && restored.enumerable === held.enumerable && restored.writable === held.writable
          && restored.configurable === held.configurable, 'MEET_FETCH_RESTORATION');
        need(unchanged, 'MEET_FETCH_DRIFT');
      } catch (error) {
        if (!first) first = error;
        else try { Object.defineProperty(first, 'meetFetchRestorationFailure', { value: error }); } catch {}
      }
      if (first) throw first;
    },
  });
}
async function withMeetFetchCleanup(action, restore) {
  need(typeof action === 'function' && typeof restore === 'function', 'MEET_FETCH_CLEANUP_PORTS');
  let result; let first; let failed = false;
  try { result = await action(); } catch (error) { first = error; failed = true; }
  try { restore(); } catch (error) {
    if (!failed) { first = error; failed = true; }
    else if (first !== null && ['object', 'function'].includes(typeof first)) {
      try { Object.defineProperty(first, 'meetFetchCleanupFailure', { value: error }); } catch {}
    }
  }
  if (failed) throw first; return result;
}

function recordingPorts(ports, typedi) {
  const deliveries = []; const pushes = [];
  const logger = { info() { counters.logger++; }, error() { counters.logger++; }, warn() { counters.logger++; }, debug() { counters.logger++; } };
  class PaymentService { createOrder() { counters.excluded++; fail('PAYMENT_CAPABILITY_EXCLUDED'); } }
  class CouponService { validateWalletCoupon() { counters.excluded++; fail('COUPON_CAPABILITY_EXCLUDED'); } }
  typedi.Service()(PaymentService); typedi.Service()(CouponService);
  const substitutes = {
    '@/services/logger': { __esModule: true, default: logger, logger, showError() { counters.logger++; } },
    '@/services/firebase': { getFirebaseMessaging: () => ({ sendEachForMulticast: async payload => recordPush(payload, pushes, counters) }) },
    '@/modules/payment/services': { PaymentService }, '@/modules/coupon/services': { CouponService },
  };
  return { substitutes, deliveries, pushes,
    adapter: async config => {
      const method = (config.method || 'get').toLowerCase();
      let destination; let body;
      if (method === 'post' && config.url === ports.recordingAxios.email) {
        const data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        need(plain(data) && Array.isArray(data.to) && data.to.length === 1 && !data.cc && !data.bcc, 'EMAIL_ENVELOPE');
        destination = data.to[0]; body = data.text_body; counters.email++;
      } else if (method === 'get' && config.url === ports.recordingAxios.sms) {
        destination = config.params.to; body = config.params.text; counters.sms++;
      } else { counters.unexpected++; fail('UNDECLARED_AXIOS_REQUEST'); }
      need(typeof destination === 'string' && typeof body === 'string', 'DELIVERY_SHAPE');
      const codes = [...body.matchAll(/\b[0-9]{6}\b/g)].map(row => row[0]);
      need(codes.length === 1, 'DELIVERY_CODE_COUNT');
      deliveries.push({ destination, code: codes[0], kind: method === 'post' ? 'email' : 'sms' });
      return { data: { success: true, data: {} }, status: 200, statusText: 'OK', headers: {}, config };
    },
  };
}

// This controller has only explicit runtime ports. Offline units supply hard fake
// ports; main binds the admitted real loader/packages below. No validator is copied.
const CONFIG_ALIAS = '@/config/config';
const CONFIG_CASE_IDS = Object.freeze(REQUIRED_CASE_IDS.slice(53, 59));
const CONFIG_MUTANT_IDS = Object.freeze(REQUIRED_SENSITIVITY_IDS.slice(14, 17));
const CONFIG_ENVIRONMENTS = Object.freeze(['test', 'development', 'production']);
const CONFIG_REJECTION = 'JWT_SECRET_KEY must be set to a non-placeholder value';
const CONFIG_ENV_KEYS = Object.freeze(['NODE_ENV', 'JWT_SECRET_KEY', 'MONGODB_URL']);
const CONFIG_EFFECT_KEYS = Object.freeze(Object.keys(counters));
const CONFIG_WRITE_OPS = new Set(['updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete']);
const CONFIG_TRIM_POINTS = Object.freeze([0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020,
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);

function configurationSamples(key) {
  need(typeof key === 'string' && key.length > 0 && key.trim() === key
    && !['your-secret-key', 'your-secret-key-change-in-production'].includes(key), 'CONFIG_FIXTURE_KEY');
  const trim = String.fromCodePoint(...CONFIG_TRIM_POINTS); const samples = [];
  function add(environment, group, name, value, accepted = false) {
    samples.push(Object.freeze({ id: environment + ':' + name, environment,
      group: CONFIG_CASE_IDS[group], value, accepted }));
  }
  for (const environment of CONFIG_ENVIRONMENTS) {
    add(environment, 0, 'unset', undefined);
    add(environment, 1, 'empty', '');
    for (const point of CONFIG_TRIM_POINTS) add(environment, 1, 'blank-' + point.toString(16), String.fromCodePoint(point));
    add(environment, 1, 'combined-blank', trim);
    for (const [index, value] of ['your-secret-key', 'your-secret-key-change-in-production'].entries()) {
      add(environment, 2, 'placeholder-' + index, value);
      add(environment, 2, 'padded-placeholder-' + index, trim + value + trim);
    }
    add(environment, 3, 'valid', key, true);
    add(environment, 4, 'padded', trim + key + trim, true);
    add(environment, 5, 'short', 'x', true);
    add(environment, 5, 'case-variant', 'Your-Secret-Key', true);
  }
  return Object.freeze(samples);
}

function configurationFinally(action, restorers) {
  let result; let primary; let failed = false; const secondary = [];
  try { result = action(); } catch (error) { primary = error; failed = true; }
  for (const restore of restorers) try { restore(); } catch (error) { secondary.push(error); }
  if (!failed && secondary.length) {
    primary = new Error('CONFIG_RESTORATION_FAILED', { cause: secondary[0] });
    primary.fixtureCode = 'CONFIG_RESTORATION_FAILED'; failed = true;
  }
  if (failed) {
    if (primary !== null && ['object', 'function'].includes(typeof primary) && secondary.length) {
      try { Object.defineProperty(primary, 'configurationCleanupFailures', { value: Object.freeze(secondary) }); } catch {}
    }
    throw primary;
  }
  return result;
}

function configurationEnvironment(env) {
  const saved = CONFIG_ENV_KEYS.map(name => ({ name, present: Object.hasOwn(env, name), value: env[name] }));
  return () => {
    // Attempt every restoration even if one assignment fails.
    let error;
    for (const row of saved) try {
      if (row.present) env[row.name] = row.value; else delete env[row.name];
      need(Object.hasOwn(env, row.name) === row.present && env[row.name] === row.value, 'CONFIG_ENV_RESTORATION');
    } catch (caught) { error ||= caught; }
    if (error) throw error;
  };
}

function withConfigurationTaps(runtime, action) {
  const { mongoose, network, effects, attempts } = runtime;
  const specs = [
    [mongoose, 'connect', 'connection'], [mongoose, 'createConnection', 'connection'],
    [mongoose.Connection?.prototype, 'openUri', 'connection'],
    [mongoose.mongo?.MongoClient?.prototype, 'connect', 'connection'],
    [network.Socket?.prototype, 'connect', 'connection'], [network.Server?.prototype, 'listen', 'listen'],
    [mongoose.Model, 'create', 'write'], [mongoose.Model, 'insertMany', 'write'], [mongoose.Model, 'bulkWrite', 'write'],
    [mongoose.Model?.prototype, 'save', 'write'], [mongoose.Query?.prototype, 'exec', 'query'],
  ];
  const installed = [];
  return configurationFinally(() => {
    for (const [target, name, category] of specs) {
      const descriptor = target && Object.getOwnPropertyDescriptor(target, name);
      need(descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
        && (descriptor.writable || descriptor.configurable), 'CONFIG_TAP_MISSING');
      const original = descriptor.value;
      const replacement = function (...args) {
        if (category === 'query' && !CONFIG_WRITE_OPS.has(this.op)) return original.apply(this, args);
        attempts[category === 'query' ? 'write' : category]++; effects.unexpected++;
        fail('CONFIG_OPERATION_ATTEMPT');
      };
      Object.defineProperty(target, name, { ...descriptor, value: replacement });
      installed.push({ target, name, descriptor, replacement });
    }
    return action();
  }, [() => {
    let error;
    for (const row of installed.reverse()) {
      try {
        const current = Object.getOwnPropertyDescriptor(row.target, row.name);
        const unchanged = current && current.value === row.replacement
          && current.writable === row.descriptor.writable && current.configurable === row.descriptor.configurable
          && current.enumerable === row.descriptor.enumerable;
        Object.defineProperty(row.target, row.name, row.descriptor);
        const restored = Object.getOwnPropertyDescriptor(row.target, row.name);
        need(restored.value === row.descriptor.value && restored.writable === row.descriptor.writable
          && restored.configurable === row.descriptor.configurable && restored.enumerable === row.descriptor.enumerable,
        'CONFIG_TAP_RESTORATION');
        need(unchanged, 'CONFIG_TAP_DRIFT');
      } catch (caught) { error ||= caught; }
    }
    if (error) throw error;
  }]);
}

function configurationSampleEvidence(expected, seen) {
  need(Array.isArray(expected) && expected.length === 108 && seen instanceof Set && seen.size === 108,
    'CONFIG_SAMPLE_SET');
  const expectedIds = expected.map(row => row.id);
  need(new Set(expectedIds).size === 108 && expectedIds.every(id => seen.has(id)), 'CONFIG_SAMPLE_SET');
  const totals = [3, 81, 12, 3, 3, 6];
  need(expected.filter(row => row.accepted).length === 12
    && CONFIG_CASE_IDS.every((id, index) => expected.filter(row => row.group === id).length === totals[index]),
  'CONFIG_SAMPLE_COUNTS');
  return Object.freeze(CONFIG_CASE_IDS.map(id => Object.freeze({ id, status: 'PASS' })));
}

function collectConfigurationEvidence(runtime) {
  need(plain(runtime) && plain(runtime.env) && plain(runtime.effects) && plain(runtime.loader)
    && plain(runtime.mongoose) && plain(runtime.network) && plain(runtime.substitutes)
    && typeof runtime.cacheHas === 'function' && typeof runtime.originalSign === 'function'
    && typeof runtime.jwt?.verify === 'function' && typeof runtime.uri === 'string'
    && runtime.uri.length > 0 && typeof runtime.loader.phase === 'function'
    && typeof runtime.loader.resetCompiled === 'function' && typeof runtime.loader.load === 'function', 'CONFIG_RUNTIME_PORTS');
  const { env, effects, loader, mongoose, uri } = runtime;
  const nominal = 'compiled/config/config.js';
  need(runtime.plan?.modules?.[CONFIG_ALIAS] === nominal
    && typeof runtime.plan.sourceFiles?.['src1/config/config.ts'] === 'string', 'CONFIG_SOURCE_BINDING');
  const targets = [nominal];
  for (const id of CONFIG_MUTANT_IDS) {
    const mutant = runtime.plan.mutants?.[id];
    need(mutant?.file === 'compiled/mutants/' + id + '.js' && mutant.source === 'src1/config/config.ts'
      && mutant.originalSha256 === runtime.plan.sourceFiles[mutant.source], 'CONFIG_MUTANT_BINDING');
    targets.push(mutant.file);
  }
  need(CONFIG_EFFECT_KEYS.every(name => Number.isSafeInteger(effects[name]) && effects[name] >= 0
    && (name === 'console' || effects[name] === 0)), 'CONFIG_PREEXISTING_EFFECT');
  const attempts = { connection: 0, listen: 0, write: 0 };
  const exportsSeen = new WeakSet(); const configsSeen = new WeakSet();
  function checkpoint() {
    need(mongoose.modelNames().length === 0 && mongoose.connection.readyState === 0, 'CONFIG_MODEL_OR_CONNECTION');
    return JSON.stringify([CONFIG_EFFECT_KEYS.map(name => effects[name]), Object.values(attempts)]);
  }
  function reset() {
    loader.phase(runtime.substitutes, {}); loader.resetCompiled();
    need(targets.every(file => !runtime.cacheHas(file)), 'CONFIG_CACHE_NOT_CLEARED');
  }
  function signature(input, exported, padded) {
    const token = runtime.originalSign({ fixture: 'configuration-key-control' }, input,
      { algorithm: 'HS256', noTimestamp: true });
    need(runtime.jwt.verify(token, input, { algorithms: ['HS256'] }).fixture === 'configuration-key-control',
      'CONFIG_SIGNATURE_CONTROL');
    need(runtime.jwt.verify(token, exported, { algorithms: ['HS256'] }).fixture === 'configuration-key-control',
      'CONFIG_SIGNATURE_EXPORT');
    if (padded) rejectSignature(token, input.trim());
  }
  function rejectSignature(token, candidate) {
    let rejected = false;
    try { runtime.jwt.verify(token, candidate, { algorithms: ['HS256'] }); }
    catch (error) { need(error instanceof Error && error.name === 'JsonWebTokenError', 'CONFIG_SIGNATURE_WRONG_ERROR'); rejected = true; }
    need(rejected, 'CONFIG_SIGNATURE_NOT_REJECTED');
  }
  function nominalPredicate(outcome, sample) {
    if (!sample.accepted) {
      need(outcome.threw && outcome.error instanceof Error && outcome.error.message === CONFIG_REJECTION,
        'CONFIG_EXPECTED_REJECTION');
    } else {
      need(!outcome.threw, 'CONFIG_UNEXPECTED_REJECTION');
      need(outcome.config.JWT_SECRET_KEY === sample.value, 'CONFIG_RAW_VALUE');
      need(outcome.config.NODE_ENV === sample.environment && outcome.config.MONGODB_URL === uri, 'CONFIG_SETTINGS_VALUE');
      signature(sample.value, outcome.config.JWT_SECRET_KEY, sample.group === CONFIG_CASE_IDS[4]);
    }
  }
  function trial(sample, mutant, inspect) {
    const restoreEnv = configurationEnvironment(env);
    return configurationFinally(() => {
      reset();
      env.NODE_ENV = sample.environment; env.MONGODB_URL = uri;
      if (sample.value === undefined) delete env.JWT_SECRET_KEY; else env.JWT_SECRET_KEY = sample.value;
      need(Object.hasOwn(env, 'JWT_SECRET_KEY') === (sample.value !== undefined)
        && env.JWT_SECRET_KEY === sample.value && env.NODE_ENV === sample.environment && env.MONGODB_URL === uri,
      'CONFIG_TRIAL_ENV');
      const overrides = mutant ? { [CONFIG_ALIAS]: runtime.plan.mutants[mutant].file } : {};
      loader.phase(runtime.substitutes, overrides);
      const before = checkpoint(); const outcome = { threw: false };
      try { outcome.exports = loader.load(CONFIG_ALIAS); } catch (error) { outcome.threw = true; outcome.error = error; }
      // The real load is measured before any intentional signature operation.
      need(checkpoint() === before, 'CONFIG_LOAD_EFFECT');
      const target = mutant ? runtime.plan.mutants[mutant].file : nominal;
      need(targets.every(file => runtime.cacheHas(file) === (!outcome.threw && file === target)), 'CONFIG_TARGET_CACHE');
      need(env.NODE_ENV === sample.environment && env.MONGODB_URL === uri
        && Object.hasOwn(env, 'JWT_SECRET_KEY') === (sample.value !== undefined) && env.JWT_SECRET_KEY === sample.value,
      'CONFIG_LOAD_ENV_DRIFT');
      if (!outcome.threw) {
        need(plain(outcome.exports) && plain(outcome.exports.CONFIG)
          && !exportsSeen.has(outcome.exports) && !configsSeen.has(outcome.exports.CONFIG), 'CONFIG_REUSED_EXPORT');
        exportsSeen.add(outcome.exports); configsSeen.add(outcome.exports.CONFIG); outcome.config = outcome.exports.CONFIG;
      }
      inspect(outcome, sample);
      need(checkpoint() === before, 'CONFIG_SIGNATURE_EFFECT');
    }, [restoreEnv, reset]);
  }
  const restoreEnv = configurationEnvironment(env);
  return configurationFinally(() => withConfigurationTaps({ ...runtime, attempts }, () => {
    reset(); const initial = checkpoint(); const samples = configurationSamples(runtime.key); const seen = new Set();
    for (const sample of samples) {
      need(!seen.has(sample.id), 'CONFIG_DUPLICATE_SAMPLE'); trial(sample, undefined, nominalPredicate); seen.add(sample.id);
    }
    const cases = configurationSampleEvidence(samples, seen); const sensitivity = [];
    for (const id of CONFIG_MUTANT_IDS) {
      for (const environment of CONFIG_ENVIRONMENTS) {
        const sample = samples.find(row => row.environment === environment
          && row.group === CONFIG_CASE_IDS[id === 'JWT_CONFIG_TRIMMED_RETURN' ? 4 : 0]);
        trial(sample, id, outcome => {
          const controlled = id === 'JWT_CONFIG_PRODUCTION_ONLY_GUARD' && environment === 'production';
          if (controlled) { nominalPredicate(outcome, sample); return; }
          let detected = false;
          try { nominalPredicate(outcome, sample); }
          catch (error) {
            const expected = id === 'JWT_CONFIG_TRIMMED_RETURN' ? 'CONFIG_RAW_VALUE' : 'CONFIG_EXPECTED_REJECTION';
            need(error?.fixtureCode === expected && error.message === expected, 'CONFIG_MUTANT_UNRELATED_FAILURE'); detected = true;
          }
          need(detected && !outcome.threw, 'CONFIG_MUTANT_NOT_DETECTED');
          need(outcome.config.NODE_ENV === environment && outcome.config.MONGODB_URL === uri, 'CONFIG_MUTANT_SETTINGS');
          if (id === 'JWT_CONFIG_TRIMMED_RETURN') {
            need(outcome.config.JWT_SECRET_KEY === sample.value.trim() && outcome.config.JWT_SECRET_KEY !== sample.value,
              'CONFIG_MUTANT_UNSAFE_RETURN');
            const token = runtime.originalSign({ fixture: 'configuration-key-control' }, sample.value,
              { algorithm: 'HS256', noTimestamp: true });
            need(runtime.jwt.verify(token, sample.value, { algorithms: ['HS256'] }).fixture === 'configuration-key-control',
              'CONFIG_SIGNATURE_CONTROL');
            rejectSignature(token, outcome.config.JWT_SECRET_KEY);
          } else need(outcome.config.JWT_SECRET_KEY === (id === 'JWT_CONFIG_PUBLISHED_FALLBACK' ? 'your-secret-key' : undefined),
            'CONFIG_MUTANT_UNSAFE_RETURN');
        });
        // Each selected source variant is followed by the same fresh nominal predicate.
        trial(sample, undefined, nominalPredicate);
      }
      sensitivity.push(Object.freeze({ id, detected: true }));
    }
    need(checkpoint() === initial && Object.values(attempts).every(value => value === 0), 'CONFIG_FINAL_EFFECT');
    return Object.freeze({ cases, sensitivity: Object.freeze(sensitivity) });
  }), [restoreEnv, reset]);
}

// All index fixture helpers below are orchestration. The actual application
// comparator is loaded only through the closed emitted-module loader after C3.
function indexObject(value, allowed, required = allowed, code = 'INDEX_DATA_SHAPE') {
  need(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const keys = Reflect.ownKeys(value);
  need(keys.every(key => typeof key === 'string') && (!allowed || keys.every(key => allowed.includes(key)))
    && (!required || required.every(key => keys.includes(key))), code);
  const out = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor && Object.hasOwn(descriptor, 'value'), code); out[key] = descriptor.value;
  }
  return out;
}
function validateIndexTypeReport(report) {
  const row = indexObject(report, ['schema', 'status', 'compiler', 'compilerSha256', 'source', 'sourceSha256',
    'libraryFiles', 'options', 'programFiles', 'diagnostics', 'tdzControl'], undefined, 'INDEX_TYPE_REPORT');
  need(row.schema === 'SD-SELECTED-INDEX-TYPECHECK-1' && row.status === 'PASS' && row.compiler === '5.9.3'
    && row.compilerSha256 === '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675'
    && row.source === INDEX_SOURCE && row.sourceSha256 === INDEX_SOURCE_SHA
    && indexArray(row.diagnostics, 0, 'INDEX_TYPE_REPORT').length === 0, 'INDEX_TYPE_REPORT');
  const libraries = indexObject(row.libraryFiles, null, null, 'INDEX_TYPE_REPORT');
  need(Object.keys(libraries).length === 45 && Object.entries(libraries).every(([name, hash]) =>
    /^lib\.[a-z0-9.]+\.d\.ts$/.test(name) && /^[a-f0-9]{64}$/.test(hash)), 'INDEX_TYPE_REPORT');
  indexObject(row.options, null, null, 'INDEX_TYPE_REPORT');
  need(indexArray(row.programFiles, 46, 'INDEX_TYPE_REPORT').length === 46
    && row.programFiles.every(name => typeof name === 'string'), 'INDEX_TYPE_REPORT');
  const control = indexObject(row.tdzControl, ['status', 'sourceSha256', 'requiredCode', 'referenceOffset', 'programFiles', 'diagnostics'], undefined, 'INDEX_TYPE_REPORT');
  need(control.status === 'REJECTED' && control.sourceSha256 === '6597c1a03c54702d89042a29263da81399934e68e8fb6c46f91c638cbe954400'
    && control.requiredCode === 2448 && Number.isSafeInteger(control.referenceOffset) && control.referenceOffset >= 0
    && indexArray(control.programFiles, 46, 'INDEX_TYPE_REPORT').length === 46
    && control.programFiles.every(name => typeof name === 'string'), 'INDEX_TYPE_REPORT');
  const diagnostics = indexArray(control.diagnostics, 100, 'INDEX_TYPE_REPORT').map(value =>
    indexObject(value, ['sourceId', 'code', 'category', 'start', 'length'], undefined, 'INDEX_TYPE_REPORT'));
  need(diagnostics.some(value => value.sourceId === 'VIRTUAL_SELECTED_INDEX_TDZ.ts' && value.code === 2448
    && value.category === 1 && value.start === control.referenceOffset && value.length === 12), 'INDEX_TYPE_REPORT');
}
function indexArray(value, limit, code = 'INDEX_DATA_SHAPE') {
  need(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, code);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  need(length && Object.hasOwn(length, 'value') && Number.isSafeInteger(length.value)
    && length.value >= 0 && length.value <= limit, code);
  const keys = Reflect.ownKeys(value);
  need(keys.length === length.value + 1 && keys.at(-1) === 'length', code);
  const out = [];
  for (let i = 0; i < length.value; i++) {
    need(keys[i] === String(i), code);
    const d = Object.getOwnPropertyDescriptor(value, keys[i]);
    need(d && Object.hasOwn(d, 'value'), code); out.push(d.value);
  }
  return out;
}
function indexLongWords(value, Long) {
  need(typeof Long === 'function' && value !== null && typeof value === 'object'
    && Object.getPrototypeOf(value) === Long.prototype, 'INDEX_CURSOR_LONG');
  const own = Reflect.ownKeys(value);
  need(own.length === 3 && own.every(key => ['low', 'high', 'unsigned'].includes(key)), 'INDEX_CURSOR_LONG');
  const values = [];
  for (const name of ['low', 'high', 'unsigned']) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    need(d && Object.hasOwn(d, 'value'), 'INDEX_CURSOR_LONG'); values.push(d.value);
  }
  need(values[2] === false && values.slice(0, 2).every(word => Number.isInteger(word)
    && word >= -2147483648 && word <= 2147483647), 'INDEX_CURSOR_LONG');
  return values.slice(0, 2);
}
function indexScalar(value, kind, Long) {
  if (typeof value === 'number') { need(Number.isFinite(value), 'INDEX_SCALAR_LONG'); return value; }
  const [low, high] = indexLongWords(value, Long);
  if (kind === 'direction') {
    need((high === 0 && low === 1) || (high === -1 && low === -1), 'INDEX_SCALAR_LONG');
    return high === 0 ? 1 : -1;
  }
  need(high === 0 && low >= 0 && (kind === 'ttl' ? low <= 2147483647 : low === 1 || low === 2), 'INDEX_SCALAR_LONG');
  return low;
}
function projectIndexRow(value, Long, budget = { nodes: 0, bytes: 0 }) {
  const active = new Set();
  function charge(value) {
    budget.nodes++;
    // Only known primitive values are serialized. Escape expansion and field/
    // array separators are conservatively charged; opaque marker data is not.
    const primitive = value === null || ['string', 'number', 'boolean'].includes(typeof value);
    budget.bytes += primitive ? Buffer.byteLength(JSON.stringify(value), 'utf8') + 4 : 6;
    need(budget.nodes <= 32768 && budget.bytes <= 256 * 1024, 'INDEX_METADATA_LIMIT');
  }
  function copy(input, context, depth = 0) {
    charge(input); need(depth <= 64, 'INDEX_METADATA_LIMIT');
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number') { need(Number.isFinite(input), 'INDEX_METADATA_DATA'); return input; }
    need(input && typeof input === 'object' && !active.has(input), 'INDEX_METADATA_DATA');
    active.add(input); let out;
    if (Array.isArray(input)) {
      out = indexArray(input, 32768).map(item => copy(item, 'data', depth + 1));
    } else {
      const values = indexObject(input, null, null, 'INDEX_METADATA_DATA'); out = {};
      for (const key of Object.keys(values)) {
        charge(key); const current = values[key]; let projected;
        if ((context === 'row' || context === 'spec') && ['indexBuildInfo', 'buildUUID'].includes(key)) {
          // Presence and original identity are retained; the value stays opaque.
          projected = current;
        } else if (context === 'spec' && key === 'key') {
          const fields = indexObject(current, null, null, 'INDEX_METADATA_DATA');
          projected = Object.keys(fields).map(name => { charge(name); charge(fields[name]); return [name, indexScalar(fields[name], 'direction', Long)]; });
        } else if (context === 'spec' && ['expireAfterSeconds', 'v'].includes(key)) {
          charge(current); projected = indexScalar(current, key === 'v' ? 'version' : 'ttl', Long);
        } else projected = copy(current, context === 'row' && key === 'spec' ? 'spec' : 'data', depth + 1);
        Object.defineProperty(out, key, { value: projected, writable: true, enumerable: true, configurable: true });
      }
    }
    active.delete(input); return out;
  }
  return copy(value, 'row');
}
function indexManifest(models) {
  need(Array.isArray(models) && JSON.stringify(models.map(row => row.collection)) === JSON.stringify(INDEX_COLLECTIONS), 'INDEX_SELECTION');
  const selected = models.map(row => ({ collection: row.collection,
    indexes: row.indexes.map(index => ({ key: Object.keys(index.key).map(field => [field, index.key[field]]), options: index.options })) }));
  need(sha(Buffer.from(JSON.stringify(selected))) === INDEX_MANIFEST_SHA
    && selected.reduce((n, row) => n + row.indexes.length, 0) === 8, 'INDEX_SELECTION');
  return selected;
}
async function collectIndexObservations(runtime) {
  const { database, collections, Long, startSession, endSession, runCommand, now, signal } = runtime;
  need(typeof database === 'string' && /^sd_api_[a-f0-9]{32}$/.test(database)
    && JSON.stringify(collections) === JSON.stringify(INDEX_COLLECTIONS)
    && [Long, startSession, endSession, runCommand, now, signal].every(value => typeof value === 'function'), 'INDEX_COLLECTOR_PORTS');
  const started = now(); need(Number.isFinite(started), 'INDEX_DEADLINE');
  const counts = { initial: 0, continuation: 0, batches: 0, rows: 0, exhausted: 0, active: 0 };
  const byCollection = []; const observations = []; const budget = { nodes: 0, bytes: 0 };
  let session; let first; let failed = false;
  try {
    session = startSession({ causalConsistency: false });
    need(session && typeof session === 'object' && typeof session.inTransaction === 'function'
      && session.inTransaction() === false, 'INDEX_SESSION');
    for (let ordinal = 0; ordinal < collections.length; ordinal++) {
      const collection = collections[ordinal]; const local = { initial: 0, continuation: 0, batches: 0, rows: 0, exhausted: false };
      const indexes = []; let cursor; let originalBits;
      for (;;) {
        const beforeCommand = now();
        // Reserve the entire fixed five-second abort allowance inside30s.
        need(Number.isFinite(beforeCommand) && beforeCommand - started <= 25000, 'INDEX_DEADLINE');
        need(local.batches < 8 && counts.batches < 64, 'INDEX_BATCH_LIMIT');
        const initial = local.batches === 0;
        const command = initial
          ? { listIndexes: collection, includeIndexBuildInfo: true, cursor: { batchSize: 1 }, maxTimeMS: 5000 }
          : { getMore: cursor, collection, batchSize: 1 };
        if (!initial) {
          const bits = indexLongWords(cursor, Long);
          need(bits[0] === originalBits[0] && bits[1] === originalBits[1] && (bits[0] !== 0 || bits[1] !== 0), 'INDEX_CURSOR_DRIFT');
        }
        const options = { promoteLongs: false, readPreference: 'primary', session, signal: signal(5000) };
        need(session.inTransaction() === false, 'INDEX_SESSION');
        const response = await runCommand(collection, command, options, initial ? null : originalBits.slice());
        need(session.inTransaction() === false, 'INDEX_SESSION');
        if (initial) { counts.initial++; local.initial++; } else { counts.continuation++; local.continuation++; }
        counts.batches++; local.batches++;
        need(Number.isFinite(now()) && now() - started <= 30000, 'INDEX_DEADLINE');
        const reply = indexObject(response, ['ok', 'cursor', 'operationTime', '$clusterTime'], ['ok', 'cursor'], 'INDEX_METADATA_REPLY');
        need(reply.ok === 1, 'INDEX_METADATA_REPLY');
        const batchName = initial ? 'firstBatch' : 'nextBatch';
        const next = indexObject(reply.cursor, ['id', 'ns', batchName], ['id', 'ns', batchName], 'INDEX_METADATA_CURSOR');
        need(next.ns === database + '.' + collection, 'INDEX_CURSOR_NAMESPACE');
        const bits = indexLongWords(next.id, Long); const isZero = bits[0] === 0 && bits[1] === 0;
        if (!initial && !isZero) need(bits[0] === originalBits[0] && bits[1] === originalBits[1], 'INDEX_CURSOR_DRIFT');
        const rows = indexArray(next[batchName], 64, 'INDEX_METADATA_BATCH');
        need(local.rows + rows.length <= 64 && counts.rows + rows.length <= 256, 'INDEX_ROW_LIMIT');
        for (const row of rows) indexes.push(projectIndexRow(row, Long, budget));
        local.rows += rows.length; counts.rows += rows.length;
        if (isZero) { local.exhausted = true; counts.exhausted++; break; }
        if (initial) { originalBits = bits; counts.active++; }
        cursor = next.id;
      }
      if (originalBits) counts.active--;
      if ([0, 2, 5, 6, 7, 8, 9, 10].includes(ordinal)) need(local.continuation >= 1, 'INDEX_CONTINUATION_REQUIRED');
      byCollection.push(local); observations.push({ collection, status: 'COMPLETE', mode: INDEX_MODE, indexes });
    }
    need(counts.initial === 13 && counts.exhausted === 13 && counts.active === 0
      && byCollection.every(row => row.initial === 1 && row.exhausted), 'INDEX_ACQUISITION_INCOMPLETE');
  } catch (error) { first = error; failed = true; }
  finally {
    if (session) {
      try { await endSession(session); } catch (error) { if (!failed) { first = error; failed = true; } }
    }
  }
  if (failed) throw first;
  return { observations, counts, byCollection };
}
function indexDescriptorOwner(target, name) {
  let owner = target;
  while (owner && !Object.hasOwn(owner, name)) owner = Object.getPrototypeOf(owner);
  need(owner, 'INDEX_TAP_MISSING'); const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  need(descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
    && (descriptor.writable || descriptor.configurable), 'INDEX_TAP_MISSING');
  return { target, name, owner, descriptor };
}
function withIndexTaps(runtime, action) {
  const { mongoose, network, jwt, axios, substitutes, globals, filesystem, attempts } = runtime;
  const specs = [[mongoose, 'connect', 'connection'], [mongoose, 'createConnection', 'connection'],
    [mongoose.Connection?.prototype, 'openUri', 'connection'], [mongoose.Connection?.prototype, 'useDb', 'connection'],
    [mongoose.mongo?.MongoClient?.prototype, 'connect', 'connection'], [mongoose.mongo?.MongoClient?.prototype, 'db', 'connection'],
    [mongoose.mongo?.Db?.prototype, 'command', 'metadata'], [mongoose.mongo?.Db?.prototype, 'collection', 'read'], [mongoose.mongo?.Db?.prototype, 'createCollection', 'write'],
    [network.Socket?.prototype, 'connect', 'connection'], [network.Server?.prototype, 'listen', 'listen'], [jwt, 'sign', 'jwt'], [axios.defaults, 'adapter', 'provider'],
    [globals, 'fetch', 'provider'], [substitutes['@/services/firebase'], 'getFirebaseMessaging', 'provider']];
  for (const name of ['find', 'aggregate', 'countDocuments', 'distinct', 'insertOne', 'insertMany', 'updateOne', 'updateMany',
    'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'createIndex', 'createIndexes', 'dropIndex', 'dropIndexes'])
    specs.push([mongoose.mongo?.Collection?.prototype, name, ['find', 'aggregate', 'countDocuments', 'distinct'].includes(name) ? 'read' : 'write']);
  for (const name of ['create', 'insertMany', 'bulkWrite']) specs.push([mongoose.Model, name, 'write']);
  for (const name of mongoose.modelNames()) specs.push([mongoose.model(name).Query.prototype, 'exec', 'query']);
  for (const name of ['info', 'error', 'warn', 'debug']) specs.push([substitutes['@/services/logger'].logger, name, 'provider']);
  for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync',
    'rm', 'rmSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync']) specs.push([filesystem, name, 'write']);
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) specs.push([filesystem.promises, name, 'write']);
  for (const name of ['setTimeout', 'setInterval', 'setImmediate']) specs.push([globals, name, 'timer']);
  const paths = specs.map(([target, name, category]) => { need(target && Number.isSafeInteger(attempts[category]), 'INDEX_TAP_MISSING'); return { ...indexDescriptorOwner(target, name), category }; });
  const unique = [];
  for (const row of paths) if (!unique.some(old => old.owner === row.owner && old.name === row.name)) unique.push(row);
  const installed = [];
  return configurationFinally(() => {
    for (const row of unique) {
      const replacement = function () { attempts.denied++; attempts[row.category]++; fail('INDEX_OPERATION_ATTEMPT'); };
      Object.defineProperty(row.owner, row.name, { ...row.descriptor, value: replacement });
      installed.push({ ...row, replacement });
    }
    return action();
  }, [() => {
    let first;
    for (const row of installed.reverse()) {
      try {
        const current = Object.getOwnPropertyDescriptor(row.owner, row.name);
        Object.defineProperty(row.owner, row.name, row.descriptor);
        need(current && current.value === row.replacement && current.writable === row.descriptor.writable
          && current.configurable === row.descriptor.configurable && current.enumerable === row.descriptor.enumerable, 'INDEX_TAP_DRIFT');
      } catch (error) { first ||= error; }
    }
    for (const row of paths) {
      try {
        const restored = indexDescriptorOwner(row.target, row.name);
        need(restored.owner === row.owner && restored.descriptor.value === row.descriptor.value
          && restored.descriptor.writable === row.descriptor.writable && restored.descriptor.configurable === row.descriptor.configurable
          && restored.descriptor.enumerable === row.descriptor.enumerable, 'INDEX_TAP_RESTORATION');
      } catch (error) { first ||= error; }
    }
    if (first) throw first;
  }]);
}

// Inert source contribution; integrated only into the admitted bootstrap.
// The fixture constructs data and assertions. It never implements readiness.
function runIndexMatrix(runtime) {
  'use strict';
  const { manifest: baseManifest, observations: baseObservations, Long, UUID, loadHelper, runDenied } = runtime;
  need(typeof Long === 'function' && typeof UUID === 'function'
    && typeof loadHelper === 'function' && typeof runDenied === 'function', 'INDEX_MATRIX_PORTS');
  const fields = ['ready', 'code', 'collectionOrdinal', 'indexOrdinal'];
  const codes = new Set(['READY', 'MANIFEST_INVALID', 'OBSERVATIONS_INVALID', 'OBSERVATION_FAILED',
    'OBSERVATION_INCOMPLETE', 'OBSERVATION_UNSUPPORTED', 'OBSERVATION_UNREADY',
    'REQUIRED_INDEX_UNSATISFIED', 'INPUT_INVALID']);
  const ready = Object.freeze({ ready: true, code: 'READY', collectionOrdinal: null, indexOrdinal: null });
  const expectedCounts = [1, 21, 28, 40, 38, 30, 14];
  const trialRows = new Map(); const groupCounts = new Map(INDEX_CASE_IDS.map(id => [id, 0]));
  for (const row of INDEX_TRIALS) {
    need(Array.isArray(row) && row.length === 4 && typeof row[0] === 'string' && !trialRows.has(row[0])
      && groupCounts.has(row[1]) && (row[3] === 'BOTH' || row[3] === 'ONE'), 'INDEX_TRIAL_SET');
    trialRows.set(row[0], row); groupCounts.set(row[1], groupCounts.get(row[1]) + 1);
  }
  need(INDEX_TRIALS.length === 172 && trialRows.size === 172 && INDEX_CASE_IDS.length === 7
    && INDEX_CASE_IDS.every((id, i) => groupCounts.get(id) === expectedCounts[i])
    && INDEX_TRIALS.filter(row => row[3] === 'ONE').length === 1
    && trialRows.get('REFLECTION_THROW')?.[3] === 'ONE', 'INDEX_TRIAL_COUNTS');
  need(INDEX_MUTANT_IDS.length === 6 && Object.keys(INDEX_MUTANTS).length === 6
    && Object.keys(INDEX_MUTANTS).every((id, i) => id === INDEX_MUTANT_IDS[i]), 'INDEX_MUTANT_SET');
  let declaredReferences = 0;
  for (const id of INDEX_MUTANT_IDS) {
    const ids = INDEX_MUTANTS[id].trials;
    need(Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length
      && ids.every(name => trialRows.has(name) && trialRows.get(name)[3] === 'BOTH'
        && trialRows.get(name)[2].ready === false), 'INDEX_MUTANT_TRIAL_SET');
    declaredReferences += ids.length;
  }
  need(declaredReferences === 75, 'INDEX_MUTANT_TRIAL_COUNTS');

  // Clone only descriptor-admitted base data. Build-marker values are opaque,
  // including native values and cycles; their references are retained verbatim.
  function cloneData(input, context = 'data', opaque = new Set(), seen = new Map()) {
    if (input === null || typeof input !== 'object') return input;
    if (opaque.has(input)) return input;
    if (seen.has(input)) return seen.get(input);
    const prototype = Object.getPrototypeOf(input);
    need(Array.isArray(input) ? prototype === Array.prototype
      : prototype === Object.prototype || prototype === null, 'INDEX_FIXTURE_BASE_DATA');
    const out = Array.isArray(input) ? [] : Object.create(prototype); seen.set(input, out);
    for (const key of Reflect.ownKeys(input)) {
      if (Array.isArray(input) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      need(descriptor && Object.hasOwn(descriptor, 'value'), 'INDEX_FIXTURE_BASE_DATA');
      const marker = (context === 'row' || context === 'spec') && (key === 'indexBuildInfo' || key === 'buildUUID');
      let value;
      if (marker) { value = descriptor.value; if (value && (typeof value === 'object' || typeof value === 'function')) opaque.add(value); }
      else {
        const next = context === 'observations' ? 'listing' : context === 'listing' && key === 'indexes' ? 'rows'
          : context === 'rows' ? 'row' : context === 'row' && key === 'spec' ? 'spec' : 'data';
        value = cloneData(descriptor.value, next, opaque, seen);
      }
      Object.defineProperty(out, key, { value, writable: true, enumerable: descriptor.enumerable, configurable: true });
    }
    if (Array.isArray(input)) out.length = Object.getOwnPropertyDescriptor(input, 'length').value;
    return out;
  }
  function capture(roots, opaque, extraReferences = []) {
    const references = new Set(extraReferences); const nodes = []; let budgetNodes = 0; let budgetStrings = 0;
    function visit(value) {
      need(++budgetNodes <= 32768, 'INDEX_FIXTURE_CONSTRUCTION_LIMIT');
      if (typeof value === 'string') { budgetStrings += value.length; need(budgetStrings <= 131072, 'INDEX_FIXTURE_CONSTRUCTION_LIMIT'); }
      if (value === null || !['object', 'function'].includes(typeof value) || references.has(value)) return;
      references.add(value);
      if (opaque.has(value) || typeof value === 'function') return;
      const prototype = Object.getPrototypeOf(value);
      need(Array.isArray(value) ? prototype === Array.prototype
        : prototype === Object.prototype || prototype === null, 'INDEX_FIXTURE_SNAPSHOT_DATA');
      const keys = Reflect.ownKeys(value); const descriptors = [];
      const node = { value, prototype, keys, descriptors, extensible: Object.isExtensible(value) }; nodes.push(node);
      for (const key of keys) {
        if (typeof key === 'string') { budgetStrings += key.length; need(budgetStrings <= 131072, 'INDEX_FIXTURE_CONSTRUCTION_LIMIT'); }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        need(descriptor, 'INDEX_FIXTURE_SNAPSHOT_DATA'); descriptors.push(descriptor);
        if (Object.hasOwn(descriptor, 'value')) visit(descriptor.value);
        else { if (descriptor.get) references.add(descriptor.get); if (descriptor.set) references.add(descriptor.set); }
      }
    }
    roots.forEach(visit); return { references, nodes };
  }
  function verifySnapshot(snapshot) {
    for (const node of snapshot.nodes) {
      const keys = Reflect.ownKeys(node.value);
      need(Object.getPrototypeOf(node.value) === node.prototype && Object.isExtensible(node.value) === node.extensible
        && keys.length === node.keys.length && keys.every((key, i) => key === node.keys[i]), 'INDEX_INPUT_MUTATION');
      keys.forEach((key, i) => {
        const before = node.descriptors[i]; const after = Object.getOwnPropertyDescriptor(node.value, key);
        need(after && Object.hasOwn(after, 'value') === Object.hasOwn(before, 'value')
          && after.enumerable === before.enumerable && after.configurable === before.configurable
          && (Object.hasOwn(before, 'value') ? Object.is(after.value, before.value) && after.writable === before.writable
            : after.get === before.get && after.set === before.set), 'INDEX_INPUT_MUTATION');
      });
    }
  }
  function freezeFixture(input) {
    const snapshot = capture(input.inspectRoots, input.opaque, input.extraReferences);
    for (let i = snapshot.nodes.length - 1; i >= 0; i--) Object.freeze(snapshot.nodes[i].value);
  }
  const sameKeyLiteral = (left, right) => Array.isArray(left) && left.length === right.length
    && left.every((entry, i) => Array.isArray(entry) && entry.length === 2
      && entry[0] === right[i][0] && entry[1] === right[i][1]);
  const nested = n => { let value = true; for (let i = 0; i < n; i++) value = { a: value }; return value; };

  function makeTrial(id) {
    const opaque = new Set(); const counts = { getters: 0, coercions: 0, functions: 0, reflections: 0 };
    let M = cloneData(baseManifest, 'data', opaque); let O = cloneData(baseObservations, 'observations', opaque);
    const extraReferences = []; let proxyTarget;
    const copy = value => cloneData(value, 'data', opaque);
    const listing = c => {
      const rows = O.filter(row => row.collection === M[c].collection);
      need(rows.length === 1, 'INDEX_FIXTURE_SELECTION'); return rows[0];
    };
    const row = (c, explicit = false) => {
      const key = explicit ? M[c].indexes[0].key : [['_id', 1]];
      const rows = listing(c).indexes.filter(item => item && item.spec && sameKeyLiteral(item.spec.key, key)
        && (explicit || item.spec.name === '_id_'));
      need(rows.length === 1, 'INDEX_FIXTURE_SELECTION'); return rows[0];
    };
    const spec = (c, explicit = false) => row(c, explicit).spec;
    const remove = (c, explicit) => { const selected = row(c, explicit); const rows = listing(c).indexes; rows.splice(rows.indexOf(selected), 1); };
    const extra = (c, n = '') => ({ spec: { name: 'fixture-extra' + n, key: [['fixtureExtra' + n, 1]] } });
    const getter = (target, key) => Object.defineProperty(target, key, { enumerable: true, configurable: true,
      get() { counts.getters++; return 'fixture-getter-canary'; } });
    const synthetic = partial => {
      M = [{ collection: 'fixture', indexes: [{ key: [['value', 1]], options: { partialFilterExpression: copy(partial) } }] }];
      O = [{ collection: 'fixture', status: 'COMPLETE', mode: 'MONGODB_8_INCLUDE_INDEX_BUILD_INFO', indexes: [
        { spec: { name: '_id_', key: [['_id', 1]] } },
        { spec: { name: 'value_1', key: [['value', 1]], partialFilterExpression: copy(partial) } },
      ] }];
    };
    const markOpaque = value => { opaque.add(value); return value; };
    const nativeCanaries = value => {
      for (const name of ['toJSON', 'toString', 'valueOf']) Object.defineProperty(value, name, {
        configurable: true, enumerable: false, writable: true,
        value() { counts.coercions++; throw 'fixture-native-coercion-canary'; },
      });
      return markOpaque(value);
    };
    const marker = suffix => {
      if (suffix === 'NULL') return null;
      if (suffix === 'FALSE') return false;
      if (suffix === 'EMPTY') return markOpaque({});
      if (suffix === 'CYCLE') { const value = {}; value.self = value; return markOpaque(value); }
      need(suffix === 'DRIVER_UUID', 'INDEX_FIXTURE_TRIAL_ID');
      return nativeCanaries(new UUID('00000000-0000-4000-8000-000000000001'));
    };
    let matched = true; let match;
    if ((match = /^REMOVE_(ID|EXPLICIT)_(\d{2})$/.exec(id))) remove(Number(match[2]), match[1] === 'EXPLICIT');
    else if ((match = /^KEY_(NAME|DIRECTION|DROP)_([0-3])$/.exec(id))) {
      const key = spec(8, true).key; const ordinal = Number(match[2]);
      if (match[1] === 'NAME') key[ordinal][0] = 'fixtureDifferent' + ordinal;
      else if (match[1] === 'DIRECTION') key[ordinal][1] = -1;
      else key.splice(ordinal, 1);
    } else if ((match = /^UNIQUE_(FALSE|ABSENT)_(\d{2})$/.exec(id))) {
      const selected = spec(Number(match[2]), true);
      if (match[1] === 'FALSE') selected.unique = false; else delete selected.unique;
    } else if ((match = /^MARKER_(WRAPPER|SPEC)_(indexBuildInfo|buildUUID)_(NULL|FALSE|EMPTY|CYCLE|DRIVER_UUID)$/.exec(id))) {
      (match[1] === 'WRAPPER' ? row(0) : spec(0))[match[2]] = marker(match[3]);
    } else switch (id) {
      case 'REAL_COMPLETE_SELECTED': break;
      case 'KEY_COMPOUND_REVERSED': spec(8, true).key.reverse(); break;
      case 'KEY_EXTRA': spec(8, true).key.push(['fixtureExtra', 1]); break;
      case 'KEY_DUPLICATE_FIELD': spec(8, true).key.push(['userId', 1]); break;
      case 'KEY_ZERO_DIRECTION': spec(0, true).key[0][1] = 0; break;
      case 'KEY_STRING_DIRECTION': spec(0, true).key[0][1] = '1'; break;
      case 'KEY_BOOLEAN_DIRECTION': spec(0, true).key[0][1] = true; break;
      case 'ID_WRONG_NAME': spec(0).name = 'fixture-renamed-id'; break;
      case 'ID_WRONG_KEY': spec(0).key = [['fixtureOther', 1]]; break;
      case 'ID_EXPLICIT_NONUNIQUE': spec(0).unique = false; break;
      case 'NONID_ABSENT_UNIQUE': delete spec(0, true).unique; break;
      case 'COLLECTION_CASE': listing(6).collection = 'otp'; break;
      case 'COLLECTION_MISSING': { const selected = listing(0); O.splice(O.indexOf(selected), 1); break; }
      case 'COLLECTION_FOREIGN': listing(0).collection = 'fixtureForeign'; break;
      case 'LISTING_DUPLICATE': { const selected = listing(1); O[O.indexOf(selected)] = copy(listing(0)); break; }
      case 'INDEX_NAME_DUPLICATE': spec(0, true).name = '_id_'; break;
      case 'INDEX_KEY_DUPLICATE': { const selected = copy(row(0, true)); selected.spec.name = 'fixture-duplicate-key'; listing(0).indexes.push(selected); break; }
      case 'SPARSE_FALSE': spec(0, true).sparse = false; break;
      case 'SPARSE_ABSENT': delete spec(0, true).sparse; break;
      case 'TTL_ABSENT': delete spec(6, true).expireAfterSeconds; break;
      case 'TTL_ONE': spec(6, true).expireAfterSeconds = 1; break;
      case 'TTL_UNEXPECTED': spec(7, true).expireAfterSeconds = 0; break;
      case 'ID_TTL_UNEXPECTED': spec(0).expireAfterSeconds = 0; break;
      case 'TTL_INVALID_NEGATIVE': spec(6, true).expireAfterSeconds = -1; break;
      case 'TTL_INVALID_FRACTION': spec(6, true).expireAfterSeconds = 0.5; break;
      case 'TTL_INVALID_STRING': spec(6, true).expireAfterSeconds = '0'; break;
      case 'TTL_INVALID_NAN': spec(6, true).expireAfterSeconds = NaN; break;
      case 'TTL_INVALID_INFINITY': spec(6, true).expireAfterSeconds = Infinity; break;
      case 'TTL_INVALID_TOO_LARGE': spec(6, true).expireAfterSeconds = 2147483648; break;
      case 'HIDDEN_REQUIRED': spec(7, true).hidden = true; break;
      case 'PARTIAL_ABSENT_8': delete spec(8, true).partialFilterExpression; break;
      case 'PARTIAL_ABSENT_9': delete spec(9, true).partialFilterExpression; break;
      case 'PARTIAL_EMPTY': spec(8, true).partialFilterExpression = {}; break;
      case 'PARTIAL_REFUND_VALUE': spec(8, true).partialFilterExpression.transactionType = 'debit'; break;
      case 'PARTIAL_REFERENCE_VALUE': spec(8, true).partialFilterExpression.referenceType = 'consultation'; break;
      case 'PARTIAL_EXISTS': spec(8, true).partialFilterExpression.referenceId.$exists = false; break;
      case 'PARTIAL_TYPE_ALIAS': spec(8, true).partialFilterExpression.referenceId.$type = 2; break;
      case 'PARTIAL_EQ_FORM': spec(8, true).partialFilterExpression.transactionType = { $eq: 'refund' }; break;
      case 'PARTIAL_ARRAY_ORDER': synthetic({ tag: { $in: ['a', 'b'] } }); O[0].indexes[1].spec.partialFilterExpression.tag.$in.reverse(); break;
      case 'PARTIAL_SCALAR_TYPE': synthetic({ tag: '1' }); O[0].indexes[1].spec.partialFilterExpression.tag = 1; break;
      case 'COLLATION_NON_SIMPLE': spec(7, true).collation = { locale: 'en' }; break;
      case 'COLLATION_EXTRA': spec(7, true).collation = { locale: 'simple', strength: 3 }; break;
      case 'COLLATION_NOT_OBJECT': spec(7, true).collation = 'simple'; break;
      case 'STATUS_FAILED': listing(0).status = 'FAILED'; listing(0).indexes = []; break;
      case 'STATUS_INCOMPLETE': listing(0).status = 'INCOMPLETE'; listing(0).indexes = []; break;
      case 'STATUS_PARTIAL_NONEMPTY': listing(0).status = 'INCOMPLETE'; break;
      case 'MODE_WRONG': listing(0).mode = 'fixtureWrongMode'; break;
      case 'MODE_NOT_STRING': listing(0).mode = false; break;
      case 'BARE_SPEC': { const selected = row(0); const rows = listing(0).indexes; rows[rows.indexOf(selected)] = selected.spec; break; }
      case 'WRAPPER_UNKNOWN': row(0).futureField = true; break;
      case 'SPEC_UNKNOWN': spec(0).prepareUnique = false; break;
      case 'EXTRA_UNKNOWN': { const value = extra(0); value.spec.storageEngine = {}; listing(0).indexes.push(value); break; }
      case 'BUILDING_EXTRA': { const value = extra(0); value.buildUUID = null; listing(0).indexes.push(value); break; }
      case 'UNSUPPORTED_BEFORE_BUILDING': spec(0).prepareUnique = false; row(0).buildUUID = null; break;
      case 'MARKER_GETTER': getter(row(0), 'buildUUID'); break;
      case 'SPEC_GETTER': getter(spec(0), 'futureField'); break;
      case 'GLOBAL_SHAPE_BEFORE_FAILED': listing(0).status = 'FAILED'; listing(0).indexes = []; delete listing(12).indexes; break;
      case 'FAILED_BEFORE_LATER_UNSUPPORTED': listing(0).status = 'FAILED'; listing(0).indexes = []; listing(1).mode = 'fixtureWrongMode'; break;
      case 'EARLIER_REQUIREMENT_BEFORE_LATER_FAILED': remove(0, false); listing(1).status = 'FAILED'; listing(1).indexes = []; break;
      case 'MODE_BEFORE_BUILDING': listing(0).mode = 'fixtureWrongMode'; row(0).buildUUID = null; break;
      case 'BUILDING_BEFORE_REQUIREMENT': row(0, true).buildUUID = null; remove(0, false); break;
      case 'MANIFEST_EMPTY': M = []; break;
      case 'MANIFEST_UNKNOWN': M[0].unknown = true; break;
      case 'MANIFEST_DUPLICATE_COLLECTION': M[1] = copy(M[0]); break;
      case 'MANIFEST_DUPLICATE_KEY': M[0].indexes.push(copy(M[0].indexes[0])); break;
      case 'MANIFEST_EXPLICIT_ID': M[0].indexes.push({ key: [['_id', 1]], options: {} }); break;
      case 'MANIFEST_ID_COMPOUND': M[0].indexes.push({ key: [['_id', 1], ['fixtureExtra', 1]], options: {} }); break;
      case 'MANIFEST_COLLECTION_LIMIT': M = Array.from({ length: 14 }, (_, i) => ({ collection: 'fixture' + i, indexes: [] })); break;
      case 'MANIFEST_INDEX_LIMIT': while (M[0].indexes.length < 9) M[0].indexes.push({ key: [['fixtureManifest' + M[0].indexes.length, 1]], options: {} }); break;
      case 'MANIFEST_COLLATION': M[7].indexes[0].options.collation = { locale: 'en' }; break;
      case 'MANIFEST_GETTER': getter(M[0], 'collection'); break;
      case 'BOTH_INPUTS_INVALID': M = []; O = null; break;
      case 'MANIFEST_BUDGET': M[0].indexes.push('x'.repeat(65537)); break;
      case 'OBS_NULL': O = null; break;
      case 'OBS_HOLE': delete O[0]; break;
      case 'OBS_ARRAY_EXTRA': O.extra = true; break;
      case 'OBS_SYMBOL': listing(0)[Symbol('fixture-symbol')] = true; break;
      case 'OBS_GETTER': getter(listing(0), 'collection'); break;
      case 'OBS_FUNCTION': spec(0).futureField = function fixtureInert() { counts.functions++; return 'fixture-function-canary'; }; break;
      case 'OBS_UNDEFINED': spec(0).futureField = undefined; break;
      case 'OBS_NAN': spec(0).futureField = NaN; break;
      case 'OBS_NATIVE_LONG': spec(0).futureField = nativeCanaries(new Long(0, 0, false)); break;
      case 'OBS_CYCLE': { const value = {}; value.self = value; spec(0).futureField = value; break; }
      case 'PARTIAL_DEPTH_7': synthetic(nested(6)); O[0].indexes[1].spec.partialFilterExpression = nested(7); break;
      case 'KEY_LIMIT': spec(0, true).key = Array.from({ length: 17 }, (_, i) => ['fixtureField' + i, 1]); break;
      case 'NAME_LIMIT': spec(0, true).name = 'x'.repeat(257); break;
      case 'OBS_STRING_BUDGET': listing(0).mode = 'x'.repeat(65537); break;
      case 'OBS_NODE_BUDGET': spec(0).futureField = Array(8192).fill(null); break;
      case 'OBS_COLLECTION_SPEC_LIMIT': while (listing(0).indexes.length < 65) listing(0).indexes.push(extra(0, listing(0).indexes.length)); break;
      case 'OBS_TOTAL_SPEC_LIMIT': for (let c = 0; c < 13; c++) while (listing(c).indexes.length < 20) listing(c).indexes.push(extra(c, listing(c).indexes.length)); break;
      case 'REFLECTION_THROW': proxyTarget = M; M = new Proxy(proxyTarget, { getPrototypeOf() { counts.reflections++; throw 'fixture-reflection-canary'; } }); extraReferences.push(M); break;
      case 'NONID_RENAMED': spec(0, true).name = 'fixture-new-name'; break;
      case 'HARMLESS_EXTRA': listing(0).indexes.push(extra(0)); break;
      case 'HIDDEN_EXTRA': { const value = extra(0); value.spec.hidden = true; listing(0).indexes.push(value); break; }
      case 'ID_UNIQUE_ABSENT': for (let c = 0; c < 13; c++) delete spec(c).unique; break;
      case 'EXPLICIT_FALSE_DEFAULTS': for (let c = 0; c < 13; c++) { spec(c).sparse = false; spec(c).hidden = false; } spec(6, true).unique = false; spec(6, true).sparse = false; spec(6, true).hidden = false; break;
      case 'SIMPLE_COLLATION': for (const item of O) for (const value of item.indexes) value.spec.collation = { locale: 'simple' }; break;
      case 'OBSERVATION_ORDER': O.reverse(); break;
      case 'PARTIAL_KEY_ORDER': { const selected = spec(8, true); const value = selected.partialFilterExpression;
        value.referenceId = Object.fromEntries(Object.entries(value.referenceId).reverse());
        selected.partialFilterExpression = Object.fromEntries(Object.entries(value).reverse()); break; }
      case 'REPEATED_ALIAS': { const value = copy(M[8].indexes[0].options.partialFilterExpression);
        M[8].indexes[0].options.partialFilterExpression = value; spec(8, true).partialFilterExpression = value; break; }
      case 'PARTIAL_QUERY_DATA_NAMES': synthetic({ constructor: 'query', indexBuildInfo: 'literal', buildUUID: 'literal' }); break;
      case 'PARTIAL_DEPTH_6': synthetic(nested(6)); break;
      case 'PROJECT_LONG_TTL': case 'PROJECT_LONG_VERSION': case 'PROJECT_LONG_DIRECTION': {
        const c = id === 'PROJECT_LONG_TTL' ? 6 : 0; const explicit = id !== 'PROJECT_LONG_VERSION';
        const original = row(c, explicit); const raw = copy(original);
        raw.spec.key = Object.fromEntries(raw.spec.key);
        if (id === 'PROJECT_LONG_TTL') raw.spec.expireAfterSeconds = new Long(0, 0, false);
        else if (id === 'PROJECT_LONG_VERSION') raw.spec.v = new Long(2, 0, false);
        else raw.spec.key[Object.keys(raw.spec.key)[0]] = new Long(1, 0, false);
        const rows = listing(c).indexes; rows[rows.indexOf(original)] = projectIndexRow(raw, Long); break;
      }
      default: matched = false;
    }
    need(matched && trialRows.has(id), 'INDEX_FIXTURE_TRIAL_ID');
    return { M, O, opaque, counts, extraReferences, inspectRoots: proxyTarget ? [proxyTarget, O] : [M, O] };
  }

  const resultReferences = new WeakSet();
  function assertResult(result, inputReferences) {
    need(result !== null && typeof result === 'object' && Object.getPrototypeOf(result) === Object.prototype
      && Object.isFrozen(result) && !resultReferences.has(result) && !inputReferences.has(result), 'INDEX_RESULT_SHAPE');
    const keys = Reflect.ownKeys(result);
    need(keys.length === 4 && keys.every((key, i) => key === fields[i]), 'INDEX_RESULT_SHAPE');
    const values = {};
    for (const key of fields) {
      const d = Object.getOwnPropertyDescriptor(result, key);
      need(d && Object.hasOwn(d, 'value') && d.enumerable === true && d.writable === false
        && d.configurable === false && !inputReferences.has(d.value), 'INDEX_RESULT_SHAPE'); values[key] = d.value;
    }
    need(typeof values.ready === 'boolean' && codes.has(values.code) && values.ready === (values.code === 'READY')
      && (values.collectionOrdinal === null || Number.isInteger(values.collectionOrdinal)
        && values.collectionOrdinal >= 0 && values.collectionOrdinal < 13)
      && (values.indexOrdinal === null || Number.isInteger(values.indexOrdinal)
        && values.indexOrdinal >= 0 && values.indexOrdinal <= 8), 'INDEX_RESULT_SHAPE');
    let mutationRefused = false;
    try { result.ready = !values.ready; } catch (error) { mutationRefused = error instanceof TypeError; }
    need(mutationRefused && fields.every(key => Object.is(Object.getOwnPropertyDescriptor(result, key).value, values[key]))
      && Object.isFrozen(result), 'INDEX_RESULT_MUTATION');
    resultReferences.add(result);
  }
  function expected(result, wanted) {
    need(fields.every(key => Object.is(result[key], wanted[key])), 'INDEX_RESULT_MISMATCH');
  }
  function checkpoint(evaluate, id, frozen) {
    const input = makeTrial(id);
    if (frozen) freezeFixture(input);
    const snapshot = capture(input.inspectRoots, input.opaque, input.extraReferences);
    let result; let first; let failed = false;
    try { result = runDenied(() => evaluate(input.M, input.O)); } catch (error) { first = error; failed = true; }
    try {
      verifySnapshot(snapshot);
      need(input.counts.getters === 0 && input.counts.coercions === 0 && input.counts.functions === 0
        && input.counts.reflections === (id === 'REFLECTION_THROW' ? 1 : 0), 'INDEX_INPUT_EXECUTION');
    } catch (error) { if (!failed) { first = error; failed = true; } }
    if (failed) throw first;
    assertResult(result, snapshot.references); return result;
  }
  const nominal = loadHelper(null); need(typeof nominal === 'function', 'INDEX_HELPER_EXPORT');
  const seen = new Set(); const passedByGroup = new Map(INDEX_CASE_IDS.map(id => [id, 0])); let nominalComparisons = 0;
  for (const row of INDEX_TRIALS) {
    const modes = row[3] === 'BOTH' ? [false, true] : [false];
    for (const frozen of modes) {
      const key = row[0] + (frozen ? ':FROZEN' : ':ORDINARY'); need(!seen.has(key), 'INDEX_TRIAL_DUPLICATE');
      expected(checkpoint(nominal, row[0], frozen), row[2]); seen.add(key); nominalComparisons++;
    }
    passedByGroup.set(row[1], passedByGroup.get(row[1]) + 1);
  }
  need(nominalComparisons === 343 && seen.size === 343
    && INDEX_CASE_IDS.every((id, i) => passedByGroup.get(id) === expectedCounts[i]), 'INDEX_MATRIX_INCOMPLETE');
  const sensitivity = []; let probeComparisons = 0; let restorationComparisons = 0;
  for (const id of INDEX_MUTANT_IDS) {
    let variantProbes = 0;
    for (const trialId of INDEX_MUTANTS[id].trials) for (const frozen of [false, true]) {
      const evaluate = loadHelper(id); need(typeof evaluate === 'function', 'INDEX_HELPER_EXPORT');
      const result = checkpoint(evaluate, trialId, frozen); let detected = false;
      try { expected(result, trialRows.get(trialId)[2]); }
      catch (error) {
        need(error?.fixtureCode === 'INDEX_RESULT_MISMATCH' && error.message === 'INDEX_RESULT_MISMATCH', 'INDEX_MUTANT_UNRELATED_FAILURE');
        detected = true;
      }
      need(detected, 'INDEX_MUTANT_NOT_DETECTED'); expected(result, ready); probeComparisons++; variantProbes++;
      const restored = loadHelper(null); need(typeof restored === 'function', 'INDEX_HELPER_EXPORT');
      expected(checkpoint(restored, trialId, frozen), trialRows.get(trialId)[2]); restorationComparisons++;
      expected(checkpoint(restored, 'REAL_COMPLETE_SELECTED', frozen), ready); restorationComparisons++;
    }
    need(variantProbes === INDEX_MUTANTS[id].trials.length * 2, 'INDEX_MUTANT_INCOMPLETE');
    sensitivity.push(Object.freeze({ id, detected: true }));
  }
  need(probeComparisons === 150 && restorationComparisons === 300 && sensitivity.length === 6,
    'INDEX_SENSITIVITY_INCOMPLETE');
  return Object.freeze({
    cases: Object.freeze(INDEX_CASE_IDS.map(id => Object.freeze({ id, status: 'PASS' }))),
    sensitivity: Object.freeze(sensitivity),
  });
}

function createIndexCommandPort(runtime) {
  const { db, client, database, Long, getDb, getClient, getSession, sessionOpen, runRaw, setPending, telemetry } = runtime;
  need(db && client && typeof database === 'string'
    && [Long, getDb, getClient, getSession, sessionOpen, runRaw, setPending].every(value => typeof value === 'function'), 'INDEX_COMMAND_PORT');
  let ordinal = 0; let currentCollection = null; let origin = null; let heldCursor = null; let heldSession;
  let inFlight = false; let failed = false;
  function handles(options) {
    const session = getSession();
    need(getDb() === db && getClient() === client && db.databaseName === database
      && session && sessionOpen() && options.session === session
      && (!heldSession || session === heldSession) && session.inTransaction() === false, 'INDEX_COMMAND_HANDLES');
    if (!heldSession) heldSession = session;
  }
  return Object.freeze({
    async run(collection, command, options, suppliedBits) {
      let first; let actionFailed = false; let result;
      try {
        need(!failed && !inFlight && ordinal < INDEX_COLLECTIONS.length
          && collection === INDEX_COLLECTIONS[ordinal], 'INDEX_COMMAND_STATE');
        const settings = indexObject(options, ['promoteLongs', 'readPreference', 'session', 'signal'], undefined, 'INDEX_COMMAND_PORT');
        handles(settings);
        need(settings.promoteLongs === false && settings.readPreference === 'primary'
          && settings.signal instanceof AbortSignal, 'INDEX_COMMAND_PORT');
        const initial = currentCollection === null; let kind;
        if (initial) {
          need(suppliedBits === null && origin === null && heldCursor === null, 'INDEX_COMMAND_STATE');
          const values = indexObject(command, ['listIndexes', 'includeIndexBuildInfo', 'cursor', 'maxTimeMS'], undefined, 'INDEX_COMMAND_PORT');
          const cursor = indexObject(values.cursor, ['batchSize'], undefined, 'INDEX_COMMAND_PORT');
          need(values.listIndexes === collection && values.includeIndexBuildInfo === true && values.maxTimeMS === 5000
            && cursor.batchSize === 1, 'INDEX_COMMAND_PORT'); kind = 'listIndexes';
        } else {
          need(currentCollection === collection && heldCursor && origin, 'INDEX_COMMAND_STATE');
          const values = indexObject(command, ['getMore', 'collection', 'batchSize'], undefined, 'INDEX_COMMAND_PORT');
          const words = indexLongWords(values.getMore, Long);
          // Supplied bits are an assertion, never the source of cursor authority.
          need(values.getMore === heldCursor && values.collection === collection && values.batchSize === 1
            && words[0] === origin[0] && words[1] === origin[1]
            && Array.isArray(suppliedBits) && suppliedBits.length === 2
            && suppliedBits[0] === origin[0] && suppliedBits[1] === origin[1], 'INDEX_COMMAND_CURSOR'); kind = 'getMore';
        }
        inFlight = true; setPending({ kind, collection }); const before = telemetry.metadata;
        result = await runRaw(command, options);
        handles(indexObject(options, ['promoteLongs', 'readPreference', 'session', 'signal'], undefined, 'INDEX_COMMAND_PORT'));
        need(telemetry.metadata === before + 1 && telemetry.forbidden === 0, 'INDEX_COMMAND_OBSERVER');
        const response = indexObject(result, ['ok', 'cursor', 'operationTime', '$clusterTime'], ['ok', 'cursor'], 'INDEX_COMMAND_REPLY');
        need(response.ok === 1, 'INDEX_COMMAND_REPLY');
        const batchName = initial ? 'firstBatch' : 'nextBatch';
        const cursor = indexObject(response.cursor, ['id', 'ns', batchName], undefined, 'INDEX_COMMAND_REPLY');
        need(cursor.ns === database + '.' + collection, 'INDEX_COMMAND_NAMESPACE');
        indexArray(cursor[batchName], 64, 'INDEX_COMMAND_REPLY');
        const words = indexLongWords(cursor.id, Long); const exhausted = words[0] === 0 && words[1] === 0;
        if (!initial && !exhausted) need(words[0] === origin[0] && words[1] === origin[1], 'INDEX_COMMAND_CURSOR');
        if (exhausted) {
          ordinal++; currentCollection = null; origin = null; heldCursor = null;
        } else {
          if (initial) origin = words.slice();
          currentCollection = collection; heldCursor = cursor.id;
        }
      } catch (error) { first = error; actionFailed = true; failed = true; }
      finally {
        inFlight = false;
        try { setPending(null); } catch (error) { if (!actionFailed) { first = error; actionFailed = true; failed = true; } }
      }
      if (actionFailed) throw first; return result;
    },
    assertComplete() {
      need(!failed && !inFlight && ordinal === INDEX_COLLECTIONS.length && currentCollection === null
        && origin === null && heldCursor === null, 'INDEX_COMMAND_INCOMPLETE');
    },
  });
}

async function collectIndexEvidence(runtime) {
  const { manifest, ports, plan, mongoose, loader, effects, readOps, writeOps } = runtime;
  const selected = indexManifest(ports.models); const db = mongoose.connection.db;
  const client = mongoose.connection.getClient(); const Long = mongoose.mongo.Long; const UUID = mongoose.mongo.UUID;
  need(db.databaseName === manifest.database && typeof Long === 'function' && typeof UUID === 'function', 'INDEX_OWNED_HANDLES');
  const heldCommand = db.command; const heldFetch = globalThis.fetch; const heldPorts = runtime.substitutes;
  const attempts = Object.fromEntries(['denied', 'connection', 'listen', 'read', 'write', 'query', 'metadata', 'jwt', 'provider', 'timer', 'import', 'loads'].map(name => [name, 0]));
  let activeSession; let sessionStarts = 0; let sessionEnds = 0; let pending;
  const telemetry = { metadata: 0, forbidden: 0 }; let scope;
  function observer(event) {
    // The fixed command port cannot issue hello. Existing driver's monitoring
    // events are separate even while an owned metadata command is awaiting IO.
    if (event.commandName === 'hello' && event.databaseName === 'admin') return;
    const collection = event.commandName === 'getMore' ? event.command?.collection : event.command?.listIndexes;
    if (pending && event.databaseName === manifest.database && event.commandName === pending.kind && collection === pending.collection) {
      telemetry.metadata++; return;
    }
    telemetry.forbidden++; fail('INDEX_UNDECLARED_COMMAND');
  }
  client.on('commandStarted', observer);
  let first; let failed = false; let evidence;
  try {
    const commandPort = createIndexCommandPort({ db, client, database: manifest.database, Long,
      getDb: () => mongoose.connection.db, getClient: () => mongoose.connection.getClient(), getSession: () => activeSession,
      sessionOpen: () => sessionEnds === 0, runRaw: (command, options) => heldCommand.call(db, command, options), telemetry,
      setPending(value) { need(value === null || !pending, 'INDEX_COMMAND_STATE'); pending = value || undefined; } });
    const collected = await collectIndexObservations({ database: manifest.database, collections: INDEX_COLLECTIONS,
      Long, now: () => performance.now(), signal: milliseconds => AbortSignal.timeout(milliseconds),
      startSession(options) {
        need(sessionStarts === 0 && options.causalConsistency === false && Object.keys(options).length === 1, 'INDEX_SESSION');
        sessionStarts++; activeSession = client.startSession(options); return activeSession;
      },
      async endSession(session) {
        need(session === activeSession && sessionEnds === 0, 'INDEX_SESSION'); sessionEnds++;
        await session.endSession();
      },
      runCommand: commandPort.run,
    });
    commandPort.assertComplete();
    need(sessionStarts === 1 && sessionEnds === 1 && telemetry.metadata === collected.counts.batches
      && telemetry.forbidden === 0 && pending === undefined, 'INDEX_ACQUISITION_COUNTS');
    scope = loader.indexScope(attempts);
    // Resolve lazy public fs.promises once outside synchronous denial windows.
    need(fs.promises && typeof fs.promises.writeFile === 'function', 'INDEX_TAP_MISSING');
    const tapRuntime = { ...runtime, globals: globalThis, filesystem: fs, attempts };
    const checkpoint = () => JSON.stringify({ effects, readOps, writeOps, telemetry,
      attempts: Object.fromEntries(Object.entries(attempts).filter(([key]) => key !== 'loads')) });
    const initial = checkpoint();
    function guarded(action, importing = false) {
      const before = checkpoint(); const beforeLoads = attempts.loads; const heldLoad = Module._load;
      const denyImport = function () { attempts.import++; fail('INDEX_NESTED_IMPORT'); };
      return configurationFinally(() => {
        if (!importing) Module._load = denyImport;
        const result = withIndexTaps(tapRuntime, action);
        need(!(result instanceof Promise) && checkpoint() === before && checkpoint() === initial
          && (importing ? attempts.loads === beforeLoads + 1 : attempts.loads === beforeLoads), 'INDEX_PURE_EFFECT');
        need(globalThis.fetch === heldFetch && runtime.substitutes === heldPorts, 'INDEX_PORT_DRIFT');
        return result;
      }, [() => {
        if (!importing) { const unchanged = Module._load === denyImport; Module._load = heldLoad; need(unchanged, 'INDEX_LOADER_DRIFT'); }
      }]);
    }
    evidence = runIndexMatrix({ manifest: selected, observations: collected.observations, Long, UUID,
      loadHelper: id => guarded(() => scope.load(id), true), runDenied: action => guarded(action) });
    need(checkpoint() === initial && attempts.loads > 0 && attempts.denied === 0, 'INDEX_FINAL_EFFECT');
  } catch (error) { first = error; failed = true; }
  finally {
    if (scope) {
      try { scope.restore(); } catch (error) { if (!failed) { first = error; failed = true; } }
    }
    try { client.removeListener('commandStarted', observer); }
    catch (error) { if (!failed) { first = error; failed = true; } }
  }
  if (failed) {
    const descriptor = first !== null && ['object', 'function'].includes(typeof first)
      ? Object.getOwnPropertyDescriptor(first, 'fixtureCode') : undefined;
    const code = descriptor && Object.hasOwn(descriptor, 'value') && INDEX_FAILURE_CODES.includes(descriptor.value)
      ? descriptor.value : 'INDEX_ACQUISITION_FAILED';
    const safe = Object.assign(new Error(code), { fixtureCode: code });
    Object.defineProperty(safe, 'cause', { value: first }); throw safe;
  }
  return evidence;
}

async function main() {
  const allowed = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'HOSTNAME', 'NODE_ENV', 'APP_RUN_ID', 'APP_ROLE', 'APP_MANIFEST_SHA']);
  need(Object.keys(process.env).every(key => allowed.has(key)) && process.env.NODE_ENV === 'test'
    && process.env.APP_ROLE === ROLE && process.cwd() === ROOT && process.version === 'v22.23.4'
    && process.platform === 'linux' && process.permission, 'UNADMITTED_ENVIRONMENT');
  need(!fs.existsSync(ROOT + '/.env'), 'ENV_FILE_NOT_ADMITTED');
  const admissionBytes = bytes('.admission.json');
  need(sha(admissionBytes) === process.env.APP_MANIFEST_SHA, 'ADMISSION_HASH');
  const plan = JSON.parse(bytes('runtime-plan.json')); const ports = JSON.parse(bytes('ports-manifest.json'));
  const manifest = inspectManifest(JSON.parse(admissionBytes), plan, ports);
  const { admitNetwork, entryKind, egressCanaryBlocked } = await import(pathToFileURL(ROOT + '/network-admission.mjs').href);
  const networkAdmission = admitNetwork({ list: () => fs.readdirSync('/sys/class/net'),
    entryType: p => entryKind(fs.lstatSync(p)), readText: p => fs.readFileSync(p, 'utf8'),
    addresses: os.networkInterfaces, report: () => fail('NETWORK_ADMISSION_FAILED') }, manifest.runId);
  for (const action of [() => fs.readFileSync('/etc/passwd'), () => fs.writeFileSync(ROOT + '/unexpected', 'fixture')]) {
    let denied = false; try { action(); } catch (error) { denied = error.code === 'ERR_ACCESS_DENIED'; }
    need(denied, 'FILESYSTEM_CANARY');
  }
  need(!process.permission.has('child') && !process.permission.has('worker') && !process.permission.has('addon'), 'PROCESS_GRANTS');
  fs.writeFileSync('/tmp/auth-api-permission-canary', 'synthetic');
  const [canary] = await Promise.allSettled([fetch('http://192.0.2.1:8080/', { signal: AbortSignal.timeout(1500) })]);
  need(egressCanaryBlocked(canary), 'EGRESS_CANARY');
  const httpPorts = closeNetwork();
  const loader = installLoader(manifest, plan, ports);
  // Synthetic settings are generated only after complete import/network/file admission.
  const key = crypto.randomBytes(32).toString('hex');
  const uri = 'mongodb://127.0.0.1:27017/' + manifest.database + '?replicaSet=' + manifest.replicaSet + '&directConnection=true';
  Object.assign(process.env, { JWT_SECRET_KEY: key, MONGODB_URL: uri, NODE_ENV: 'test',
    SMTP2GO_API_KEY: 'fixture-only', SMTP2GO_SENDER: 'fixture@example.com',
    SMS_API_BASE_URL: ports.recordingAxios.sms, SMS_USERNAME: 'fixture', SMS_PASSWORD: 'fixture', SMS_FROM: 'fixture',
    ...ports.recordingMeet.environment });
  require('reflect-metadata');
  const typedi = require('typedi'); const axios = require('axios'); const jwt = require('jsonwebtoken'); const mongoose = require('mongoose');
  const originalSign = jwt.sign; jwt.sign = (...args) => { counters.jwtIssued++; return originalSign(...args); };
  // Close the complete connection policy before any production module import.
  need(mongoose.modelNames().length === 0, 'PREEXISTING_DOMAIN_MODELS');
  mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
  const originalConnect = mongoose.connect.bind(mongoose);
  mongoose.connect = (candidate, options) => { need(candidate === uri && !options?.dbName, 'UNDECLARED_DATABASE_URI'); return originalConnect(candidate, options); };
  mongoose.createConnection = () => fail('EXTRA_DATABASE_CONNECTION');
  const openUri = mongoose.Connection.prototype.openUri;
  mongoose.Connection.prototype.openUri = function (candidate, options) {
    need(candidate === uri && (!options?.dbName || options.dbName === manifest.database), 'UNDECLARED_DATABASE_URI');
    return openUri.call(this, candidate, options);
  };
  mongoose.Connection.prototype.useDb = function (name) {
    need(name === manifest.database, 'OTHER_DATABASE_NAME'); return this;
  };
  const driverConnect = mongoose.mongo.MongoClient.prototype.connect;
  mongoose.mongo.MongoClient.prototype.connect = function (...args) {
    need(this.s?.url === uri, 'UNDECLARED_DRIVER_URI'); return driverConnect.apply(this, args);
  };
  const driverDb = mongoose.mongo.MongoClient.prototype.db;
  mongoose.mongo.MongoClient.prototype.db = function (name, options) {
    need((name || this.options?.dbName) === manifest.database, 'OTHER_DRIVER_DATABASE');
    return driverDb.call(this, name, options);
  };
  const collections = new Set(ports.models.map(row => row.collection));
  const driverCollection = mongoose.mongo.Db.prototype.collection;
  mongoose.mongo.Db.prototype.collection = function (name, options) {
    need(this.databaseName === manifest.database && collections.has(name), 'UNDECLARED_COLLECTION');
    return driverCollection.call(this, name, options);
  };
  const createCollection = mongoose.mongo.Db.prototype.createCollection;
  mongoose.mongo.Db.prototype.createCollection = function (name, options) {
    need(this.databaseName === manifest.database && collections.has(name), 'UNDECLARED_COLLECTION_CREATE');
    return createCollection.call(this, name, options);
  };
  const writeOps = Object.fromEntries([...collections].map(name => [name, 0]));
  const readOps = Object.fromEntries([...collections].map(name => [name, 0]));
  const meetLifecycle = meetFetchLifecycle(globalThis, ports.recordingMeet, counters);
  let currentMeet; let currentPorts; let server;
  function phase(overrides = {}) {
    if (server) fail('PHASE_SERVER_STILL_OPEN');
    currentMeet = meetLifecycle.phase();
    typedi.Container.of().reset({ strategy: 'resetServices' });
    loader.resetCompiled();
    currentPorts = recordingPorts(ports, typedi); loader.phase(currentPorts.substitutes, overrides);
    axios.defaults.adapter = currentPorts.adapter;
    const express = require('express'); const app = express(); app.use(express.json({ limit: '16kb' }));
    const authenticate = loader.load('@/modules/middleware/auth').authenticate;
    app.use('/api/v1/auth', loader.load('@/modules/auth/routes').default);
    app.use('/api/v1/users', authenticate, loader.load('@/modules/user/routes').default);
    app.use('/api/v1/wallet', authenticate, loader.load('@/modules/wallet/routes').default);
    app.use('/api/v1/dependents', authenticate, loader.load('@/modules/dependents/routes').default);
    app.use('/api/v1/notifications', authenticate, loader.load('@/modules/notification/routes').default);
    app.use('/api/v1/fcm', authenticate, loader.load('@/modules/fcm/routes').default);
    app.use('/api/v1/meet', loader.load('@/modules/meet/routes').default);
    app.use(loader.load('@/modules/middleware/errorHandler').errorHandler);
    return new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => { const port = server.address().port; httpPorts.add(port); resolve(port); });
      server.once('error', reject);
    });
  }
  const endPhase = async () => {
    if (!server) return;
    const active = server; const port = active.address().port; server = undefined;
    await new Promise((resolve, reject) => active.close(error => error ? reject(error) : resolve())); httpPorts.delete(port);
  };
  let port;
  const completed = await withMeetFetchCleanup(() => withOwnedCleanup(async () => {
    // Recording/sentinel ports precede the first intentional CONFIG domain load.
    currentMeet = meetLifecycle.phase();
    currentPorts = recordingPorts(ports, typedi); loader.phase(currentPorts.substitutes);
    axios.defaults.adapter = currentPorts.adapter;
    const configurationEvidence = collectConfigurationEvidence({ env: process.env, effects: counters,
      loader, plan, mongoose, network: net, substitutes: currentPorts.substitutes, originalSign, jwt, key, uri,
      cacheHas: relative => Object.hasOwn(require.cache, path.join(ROOT, relative)) });
    need(process.env.NODE_ENV === 'test' && process.env.JWT_SECRET_KEY === key && process.env.MONGODB_URL === uri,
      'CONFIG_FINAL_ENV');
    need(Object.entries(ports.recordingMeet.environment).every(([name, value]) => process.env[name] === value), 'MEET_CONFIG_ENV_DRIFT');
    // Router imports register actual production models, still without any connection.
    stage = 'ROUTER_IMPORT'; port = await phase();
    need(JSON.stringify(mongoose.modelNames().sort()) === JSON.stringify(ports.models.map(row => row.name).sort()), 'UNDECLARED_REGISTERED_MODEL');
    for (const spec of ports.models) need(mongoose.model(spec.name).collection.collectionName === spec.collection
      && Object.hasOwn(plan.sourceFiles, spec.source), 'MODEL_COLLECTION_SOURCE');
    stage = 'OWNED_DATABASE_CONNECT';
    await runSetupStep('CONNECT', () => mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000, monitorCommands: true }));
    const hello = await runSetupStep('HELLO', () => mongoose.connection.db.admin().command({ hello: 1 }));
    need(hello.setName === manifest.replicaSet && mongoose.connection.name === manifest.database, 'OWNED_DATABASE_HANDSHAKE');
    need(JSON.stringify(mongoose.modelNames().sort()) === JSON.stringify(ports.models.map(row => row.name).sort()), 'UNDECLARED_REGISTERED_MODEL');
    for (const spec of ports.models) {
      const registered = mongoose.model(spec.name);
      need(registered.collection.collectionName === spec.collection && Object.hasOwn(plan.sourceFiles, spec.source), 'MODEL_COLLECTION_SOURCE');
      await runSetupStep('COLLECTION_CREATE', () => mongoose.connection.db.createCollection(spec.collection));
      for (const index of spec.indexes) await runSetupStep('INDEX_CREATE', () => mongoose.connection.db.collection(spec.collection).createIndex(index.key, index.options));
    }
    const indexEvidence = await collectIndexEvidence({ manifest, ports, plan, mongoose, loader, effects: counters,
      readOps, writeOps, network: net, jwt, axios, substitutes: currentPorts.substitutes });
    mongoose.connection.getClient().on('commandStarted', event => {
      recordReadOperation(event, manifest.database, readOps, counters);
      if (event.databaseName === manifest.database && ['insert', 'update', 'findAndModify', 'delete'].includes(event.commandName)) {
        counters.dbWrites++;
        const collection = event.command[event.commandName];
        const count = event.commandName === 'insert' ? event.command.documents.length
          : event.commandName === 'update' ? event.command.updates.length : event.commandName === 'delete' ? event.command.deletes.length : 1;
        if (!Object.hasOwn(writeOps, collection)) counters.unexpected++;
        else writeOps[collection] += count;
      }
    });
    stage = 'API_SCENARIOS';
    const result = await require('./scenario.cjs').runScenario({ manifest, plan, ports, mongoose, jwt,
      key, originalSign, counters, writeOps, readOps, need, fail, load: loader.load, configurationEvidence, indexEvidence,
      get deliveries() { return currentPorts.deliveries; },
      get pushes() { return currentPorts.pushes; },
      get meetRequests() { return currentMeet.meetRequests; },
      expectMeetRequests(expected) { currentMeet.expectMeetRequests(expected); },
      get port() { return port; },
      async nextPhase(overrides) { await endPhase(); port = await phase(overrides); },
    });
    currentMeet.assertDone();
    need(result.failed === 0 && result.skipped === 0 && counters.unexpected === 0 && counters.excluded === 0, 'CASE_OR_EFFECT_FAILURE');
    need(JSON.stringify(result.cases.map(row => row.id).sort()) === JSON.stringify(ports.requiredCaseIds.slice().sort())
      && result.cases.every(row => row.status === 'PASS'), 'MISSING_REQUIRED_CASE');
    need(JSON.stringify(result.sensitivity.map(row => row.id).sort()) === JSON.stringify(ports.requiredSensitivityIds.slice().sort())
      && result.sensitivity.every(row => row.detected === true), 'MISSING_SENSITIVITY');
    need(JSON.stringify(Object.keys(result.providerSummary).sort()) === JSON.stringify(plan.providerCounterKeys.slice().sort())
      && Object.values(result.providerSummary).every(value => Number.isSafeInteger(value) && value >= 0)
      && result.providerSummary.unexpected === 0 && result.providerSummary.deniedCapabilities === 0, 'PROVIDER_COUNTER_SHAPE');
    return { schema: 'SD-AUTH-API-RESULT-1', runId: manifest.runId, role: ROLE,
      database: manifest.database, replicaSet: manifest.replicaSet, sourceCommit: manifest.sourceCommit,
      admissionPassed: true, networkAdmission, egressBlocked: true, filesystemCanariesPassed: true,
      cases: result.cases, sensitivity: result.sensitivity, failed: 0, skipped: 0,
      providerSummary: result.providerSummary, domainScope: 'FOCUSED_PRODUCTION_ROUTERS' };
  }, endPhase, () => mongoose.disconnect()), () => meetLifecycle.restore());
  stdout(JSON.stringify(completed) + '\n');
}

if (require.main === module) main().catch(error => {
  const fieldNames = error && error.errors ? Object.keys(error.errors).filter(name => /^[A-Za-z0-9_.]+$/.test(name)).slice(0, 20) : [];
  stdout(JSON.stringify({ schema: 'SD-AUTH-API-FAILURE-1', stage,
    code: typeof error.fixtureCode === 'string' ? error.fixtureCode : 'RUNTIME_FIXTURE_FAILED',
    errorType: typeof error.name === 'string' ? error.name : 'Error', fieldNames,
    failed: 1, skipped: 0 }) + '\n');
  process.exitCode = 1;
});
module.exports = { validateAdmissionData, inspectManifest, closeNetwork, installLoader, runSetupStep, SETUP_FAILURE_CODES,
  withOwnedCleanup, recordReadOperation, recordPush, configurationSamples, configurationFinally,
  configurationEnvironment, withConfigurationTaps, configurationSampleEvidence, collectConfigurationEvidence,
  meetData, meetSame, createMeetRecorder, meetFetchLifecycle, withMeetFetchCleanup,
  indexLongWords, indexScalar, projectIndexRow, indexManifest, collectIndexObservations, withIndexTaps, validateIndexTypeReport, createIndexCommandPort,
  INDEX_SOURCE_SHA, INDEX_MUTANTS };
