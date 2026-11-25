import { Schema, model, Model } from 'mongoose';

/**
 * Assisted booking phase 1a (§5.3, P2): each captured card top-up of a partner wallet is a LOT. Only lot money can ever
 * be withdrawn (phase 4): withdrawable = Σ `remainingMinor` over lots that are not closed, whose gateway fee is known
 * and that have no open dispute. Spending consumes lots first (oldest first), then non-withdrawable money (D9); a
 * refund restores exactly the allocations it reverses (a closed lot is never restored).
 */
export interface IWalletTopupLot {
  walletRef: { kind: 'pharmacy' | 'lab' | 'doctor'; id: string };
  paymentRecordId: string;
  amountMinor: number;
  /** Razorpay `fee` alone (GST included); unknown until the gateway reports it. */
  gatewayFeeMinor?: number;
  feeState: 'unknown' | 'known';
  disputeState: 'none' | 'open' | 'lost';
  closed: boolean;
  remainingMinor: number;
  /**
   * Review of 800dfc0 (item 1): recorded at a chargeback of a top-up credited without a lot (switch off, before
   * sync-indexes or before phase 1a): closed from the start, nothing in it, never withdrawable.
   */
  openedAtChargeback?: boolean;
  /** r13 (O2, partner wallets): card money becomes withdrawable from this time (7 days after payment); read by phase 4. */
  withdrawableAfter?: Date;
  /** r32 (§26.8.4): the admin's "Recover" (or a pre-r32 `take` chargeback) debited this lot's money: never again. */
  chargedBackAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const lotSchema = new Schema<IWalletTopupLot>({
  walletRef: {
    kind: { type: String, required: true, enum: ['pharmacy', 'lab', 'doctor'] },
    id: { type: String, required: true },
  },
  paymentRecordId: { type: String, required: true },
  amountMinor: { type: Number, required: true, min: 1 },
  gatewayFeeMinor: { type: Number, min: 0 },
  feeState: { type: String, required: true, enum: ['unknown', 'known'] },
  disputeState: { type: String, required: true, enum: ['none', 'open', 'lost'], default: 'none' },
  closed: { type: Boolean, required: true, default: false },
  remainingMinor: { type: Number, required: true, min: 0 },
  openedAtChargeback: { type: Boolean },
  withdrawableAfter: { type: Date },
  chargedBackAt: { type: Date },
}, { timestamps: true, strict: 'throw' });
lotSchema.index({ paymentRecordId: 1 }, { unique: true });
lotSchema.index({ 'walletRef.kind': 1, 'walletRef.id': 1, createdAt: 1 });
lotSchema.index({ feeState: 1, createdAt: 1 });
// r32 (§26.8.5): what is withdrawable now, per wallet.
lotSchema.index({ 'walletRef.kind': 1, 'walletRef.id': 1, withdrawableAfter: 1 });

export const WalletTopupLotModel: Model<IWalletTopupLot> = model<IWalletTopupLot>('WalletTopupLot', lotSchema, 'wallet_topup_lots');
export default WalletTopupLotModel;
