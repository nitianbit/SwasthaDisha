import { AppError } from '@/modules/common/types';

/**
 * Assisted booking phase 1a switches (design §15). Read from the environment on every call (tests and a restart
 * change them); every switch is OFF unless set to the exact string "true". Thresholds default to ASSUMED D10.
 *
 * - ASSISTED_BOOKING_ENABLED_PHARMACY: pharmacy lookups, the doctor list, new assisted consultations, top-up lots,
 *   typed-name edits. Off: those answer 503 ASSISTED_BOOKING_DISABLED (top-ups keep the old behaviour, without lots).
 *   Cancellations, reschedules, refunds and reads keep working whatever the switch says (§15 rollback).
 * - ASSISTED_ADMIN_TOOLS_ENABLED: the holder's "this isn't mine", the admin move / dismiss and the wallet freeze.
 * - ASSISTED_RECONCILIATION_ENABLED: the daily reconciliation job (stored report, alerts, gateway-fee fill).
 * - WALLET_RECHARGE_SWEEP_FROM: ISO time; wallet top-ups created from then on join the payment recovery sweep.
 */
const on = (name: string) => process.env[name] === 'true';
const int = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
};

export const assistedFlags = {
  pharmacy: () => on('ASSISTED_BOOKING_ENABLED_PHARMACY'),
  adminTools: () => on('ASSISTED_ADMIN_TOOLS_ENABLED'),
  reconciliation: () => on('ASSISTED_RECONCILIATION_ENABLED'),
  /**
   * Phase 1b: new assisted bookings paid by card/UPI (Razorpay). Off: `paymentMethod: 'razorpay'` answers 400
   * PAYMENT_METHOD_UNAVAILABLE as in 1a. Verify, reconcile, the sweeps, late captures and card refunds of bookings already
   * made keep working whatever it says (money in flight is never stranded).
   */
  card: () => on('ASSISTED_CARD_PAYMENT_ENABLED'),
  /**
   * r11 (§24.4.6): pharmacy → lab test bookings (the lab list, catalogue and slot reads, and new bookings). Needs
   * ASSISTED_BOOKING_ENABLED_PHARMACY too. Reads, cancellations, accept-reschedule, refunds, report access and by-key
   * always work.
   */
  pharmacyLab: () => on('ASSISTED_LAB_BOOKING_ENABLED_PHARMACY'),
  /**
   * r13 (§24.7.4): lab wallets — new lab top-ups, and lots on their credits (2e: lab-made consultations). Off: a new
   * top-up answers 503 ASSISTED_BOOKING_DISABLED; verify, reconcile, the check, the sweep, reads and admin tools run.
   */
  lab: () => on('ASSISTED_BOOKING_ENABLED_LAB'),
  /**
   * r20 (§25.4.5): doctor wallets — new doctor top-ups, and lots on their credits. Off: a new top-up answers 503
   * ASSISTED_BOOKING_DISABLED; verify, reconcile, the check, the sweep and the admin tools run.
   */
  doctor: () => on('ASSISTED_BOOKING_ENABLED_DOCTOR'),
  /** Phase 4 (GATE-RBI): withdrawals are not built in 1a; the flag is only reported. */
  withdrawals: () => on('WALLET_WITHDRAWALS_ENABLED'),
  rechargeSweepFrom: (): Date | null => {
    const raw = process.env.WALLET_RECHARGE_SWEEP_FROM;
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? new Date(t) : null;
  },
};

/** ASSUMED D10 defaults; each can be changed with its environment variable. */
export const assistedLimits = {
  lookupsPerHour: () => int('ASSISTED_LIMIT_LOOKUPS_PER_HOUR', 120),
  newAccountsPerDay: () => int('ASSISTED_LIMIT_NEW_ACCOUNTS_PER_DAY', 30),
  bookingsPerPhonePerDay: () => int('ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY', 5),
  bookerCancellationsPerDay: () => int('ASSISTED_LIMIT_BOOKER_CANCELLATIONS_PER_DAY', 20),
  cancelRateAlertPct: () => int('ASSISTED_ALERT_CANCEL_RATE_PCT', 30),
  cancelRateAlertMin: () => int('ASSISTED_ALERT_CANCEL_RATE_MIN', 10),
  samePairAlertPerDay: () => int('ASSISTED_ALERT_SAME_PAIR_PER_DAY', 10),
  /** r10b: card bookings of one booker waiting for payment at once. */
  pendingCardBookings: () => int('ASSISTED_LIMIT_PENDING_CARD_BOOKINGS', 10),
};

export const disabled = (what = 'Assisted booking') =>
  new AppError({ status: 503, code: 'ASSISTED_BOOKING_DISABLED', message: `${what} is not switched on yet` });

export function assertPharmacyAssistedOn(): void {
  if (!assistedFlags.pharmacy()) throw disabled();
}

export function assertAdminToolsOn(): void {
  if (!assistedFlags.adminTools()) throw disabled('This assisted-booking tool');
}

/** r11: both switches must be on for the pharmacy lab-booking reads and new bookings. */
export function assertPharmacyLabOn(): void {
  if (!assistedFlags.pharmacy() || !assistedFlags.pharmacyLab()) throw disabled('Lab test booking for patients');
}

/** r13: lab wallet top-ups (§24.7.4). */
export function assertLabWalletOn(): void {
  if (!assistedFlags.lab()) throw disabled('Lab wallet top-up');
}

/** r20: doctor wallet top-ups (§25.4.5). */
export function assertDoctorWalletOn(): void {
  if (!assistedFlags.doctor()) throw disabled('Doctor wallet top-up');
}
