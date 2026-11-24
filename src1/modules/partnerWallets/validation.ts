import Joi from 'joi';
import { LAB_WALLET_POLICY } from '@/modules/partnerWallets/ledger';
import { ADMIN_TOPUP_KEY } from '@/modules/pharmacyWallet/validation';
import { ASSISTED_KEY } from '@/modules/assisted/consultations';

/** r13 (§24.7.3): lab wallet requests. Amounts are integer paise. */

export const labTopupSchema = Joi.object({
  amountMinor: Joi.number().integer().min(LAB_WALLET_POLICY.minTopupMinor).max(LAB_WALLET_POLICY.maxBalanceMinor).required(),
  requestKey: Joi.string().pattern(ASSISTED_KEY).required(),
});
export const pageQuerySchema = Joi.object({
  cursor: Joi.string().pattern(/^\d{1,15}_[0-9a-fA-F]{24}$/),
  limit: Joi.number().integer().min(1).max(50),
});
/** Admin top-up: at most ₹2,00,000 at one time (the pharmacy admin form's cap), a note of at most 500 characters. */
export const adminLabTopupSchema = Joi.object({
  amountMinor: Joi.number().integer().min(1).max(LAB_WALLET_POLICY.adminTopupMaxMinor).required(),
  notes: Joi.string().trim().max(500),
});
export const adminKeyParamSchema = Joi.object({ partnerId: Joi.string().required(), key: Joi.string().pattern(ADMIN_TOPUP_KEY).required() });
