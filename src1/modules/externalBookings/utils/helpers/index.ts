export const normalizeDobToYyyymmdd = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (/^\d{8}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed.replace(/-/g, '');
  }

  return undefined;
};

export const calculateAgeFromDob = (dateOfBirth?: string): string | undefined => {
  const normalizedDob = normalizeDobToYyyymmdd(dateOfBirth);
  if (!normalizedDob) {
    return undefined;
  }

  const year = Number(normalizedDob.slice(0, 4));
  const month = Number(normalizedDob.slice(4, 6));
  const day = Number(normalizedDob.slice(6, 8));
  if (!year || !month || !day) {
    return undefined;
  }

  const today = new Date();
  let age = today.getFullYear() - year;
  const monthDiff = (today.getMonth() + 1) - month;
  const dayDiff = today.getDate() - day;
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }

  if (age < 0 || !Number.isFinite(age)) {
    return undefined;
  }

  return String(age);
};

export const toLabstackGender = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'male') {
    return 'MALE';
  }
  if (normalized === 'female') {
    return 'FEMALE';
  }
  if (normalized === 'other') {
    return 'OTHER';
  }

  return value;
};
