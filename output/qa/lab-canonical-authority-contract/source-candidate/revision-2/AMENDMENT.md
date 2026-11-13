# Stored-proof bounds repair — source only

Both actual initial source axes requested the same narrow repair. Before any JSON.parse of stored proof or outer JSON.stringify reconstruction, history now checks primitive commandJson UTF8 bytes<=16384 and primitive signatureBase64 encoded length88. Existing canonical64-byte decoding/reencoding and proof/history/regrant/replay semantics remain untouched. Malformed stored state rejects503.

Only the writer and generated source manifest changed. Originalcf9 and both actual review records remain preserved. All actual parser/crypto/native/database/runtime checks are NOT_RUN. Two fresh nonauthor amendment/composition votes and later focused execution remain required; author supplies no self-approval.
