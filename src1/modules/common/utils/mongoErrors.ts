// Mongo duplicate-key errors (unique index violations). Single writes carry
// code 11000 directly; bulk writes (insertMany) nest them inside writeErrors.
export const isDuplicateKeyError = (error: unknown): boolean => {
  const err = error as { code?: unknown; writeErrors?: Array<{ code?: unknown }> };
  if (err?.code === 11000) {
    return true;
  }
  return Array.isArray(err?.writeErrors) && err.writeErrors.some((e) => e?.code === 11000);
};
