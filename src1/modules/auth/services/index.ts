import { randomInt } from 'node:crypto';
import { CONFIG } from '@/config/config';
import {
  SendCorporateEmailVerificationOTPRequest,
  SendEmailVerificationOTPRequest,
  SendOTPRequest,
  VerifyCorporateEmailVerificationOTPRequest,
  VerifyEmailVerificationOTPRequest,
  VerifyOTPRequest,
} from '@/modules/auth/types';
import { CorporateRepository } from '@/modules/corporates/repository';
import { AppError } from '@/modules/common/types';
import { selectCustomerLoginContact } from '@/modules/auth/validation';
import { OTPService } from '@/modules/otp/services';
import { destinationId, hit as otpLimit, limits as otpLimits, throttleId } from '@/modules/otp/throttle';
import { AdminRepository } from '@/modules/admin/repository';
import { IAdmin } from '@/modules/admin/types';
import { HRRepository } from '@/modules/hr/repository';
import { IHR } from '@/modules/hr/types';
import { UserRepository } from '@/modules/user/repository';
import { IUser } from '@/modules/user/types';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { ISpecialist } from '@/modules/specialists/types';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { IPharmacy } from '@/modules/pharmacies/types';
import { MemberRepository } from '@/modules/partners/repository/member';
import { IMember } from '@/modules/partners/types';
import { WalletService } from '@/modules/wallet/services';
import { NotificationService } from '@/modules/notification/services';
import { EmailService } from '@/modules/email/services';
import { SMSService } from '@/modules/sms/services';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import PartnerModel from '@/modules/partners/model';
import { PartnerSelectionTicketModel } from '@/modules/auth/model/partnerSelection';
import { createHmac } from 'crypto';

/**
 * Q7: selection tickets are signed with their own key (derived from the secret, never the access-token key) and their
 * own audience, so no access-token verification can ever accept one (and the access middleware refuses any token
 * carrying a purpose).
 */
const SELECTION_AUDIENCE = 'partner-select';
/** The identity a partner sign-in proved: the phone, or (sign-in by email) the lower-cased email. */
type PartnerIdentity = { phone: string; email?: undefined } | { email: string; phone?: undefined };
const selectionKey = () => createHmac('sha256', CONFIG.JWT_SECRET_KEY).update('q7:partner-selection-ticket').digest('hex');
import { advanceCredentialVersion, credentialFilter, readCredentialVersion, tokenCredentialVersion } from '@/modules/user/credentialGeneration';
import { Service } from 'typedi';

@Service()
export class AuthService {
  constructor(
    private userRepository: UserRepository,
    private adminRepository: AdminRepository,
    private hrRepository: HRRepository,
    private specialistRepository: SpecialistRepository,
    private pharmacyRepository: PharmacyRepository,
    private corporateRepository: CorporateRepository,
    private otpService: OTPService,
    private walletService: WalletService,
    private notificationService: NotificationService,
    private emailService: EmailService,
    private smsService: SMSService,
    private memberRepository: MemberRepository
  ) {}

  private normalizeEmail(email?: string): string | undefined {
    return email?.trim().toLowerCase();
  }

  /** Milestone F4: a customer may add or re-verify their own email; replacing an existing one is admin-only. */
  private assertPersonalEmailVerificationTarget(stored: string | undefined, target: string | undefined): void {
    const current = this.normalizeEmail(stored);
    if (current && current !== target) {
      throw new AppError({
        status: 422,
        code: 'EMAIL_CHANGE_ADMIN_ONLY',
        message: 'Only an admin can replace an existing email address',
      });
    }
  }

  private async ensureEmailAvailableAcrossUserFields(
    email: string,
    excludeUserId?: string
  ): Promise<void> {
    const existingUser = await this.userRepository.findByAnyEmail(
      email,
      'user',
      excludeUserId
    );

    if (existingUser) {
      throw new AppError({
        status: 400,
        code: 'EMAIL_ALREADY_IN_USE',
        message: 'Email is already in use by another user',
      });
    }
  }

  /**
   * Sign-up rows are made by mobile number only (an unknown email is EMAIL_NOT_REGISTERED). An email sent in the same
   * request is never stored: the code proves only the phone, so storing it would let anyone attach someone else's
   * address to their account (a later email sign-in would mail that person a code into it).
   */
  private buildSpecialistSignupPayload(data: SendOTPRequest): ISpecialist {
    const normalizedPhone = data.phone?.trim();

    return {
      name: 'demoName',
      phone: normalizedPhone,
      isActive: true,
      isVerified: false,
    };
  }


  async sendOTP(data: SendOTPRequest): Promise<{ message: string }> {
    const customerContact = data.userType === 'user'
      ? selectCustomerLoginContact(data, false)
      : undefined;
    const customerIdentity: { phone?: string; email?: string } | undefined = customerContact
      ? { [customerContact.target]: customerContact.targetValue }
      : undefined;
    // O1: limited per destination before anything happens (no lookup, no sign-up row, no SMS).
    const sendTarget = customerContact?.target ?? (data.phone ? 'phone' : 'email');
    const sendValue = customerContact?.targetValue ?? (data.phone?.trim() || data.email?.trim().toLowerCase() || '');
    await otpLimit('send', destinationId(sendTarget, sendValue), otpLimits.send());

    const otp = randomInt(100000, 1000000).toString();

    // Find identity record based on userType
    let userRecord: IUser | IAdmin | ISpecialist | IHR | IPharmacy | null;
    if (data.userType === 'admin') {
      userRecord = await this.adminRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'hr') {
      userRecord = await this.hrRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'specialist') {
      userRecord = await this.specialistRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'pharmacy') {
      userRecord = data.phone
        ? await this.pharmacyRepository.findByPhone(data.phone)
        : await this.pharmacyRepository.findByEmail(data.email!);
    } else if (data.userType === 'partner') {
      const members = await this.partnerMembersOf(data.phone ? { phone: data.phone } : { email: data.email });
      // Q7: with several memberships and no choice yet, the code is bound to the first membership (partnerId order,
      // the same at verify); after the code proves the phone, the person chooses (selectPartner).
      if (data.partnerId) {
        userRecord = (members.find(m => String((m as any).partnerId) === data.partnerId) as any) ?? null;
      } else {
        userRecord = members.length > 0 ? (members[0] as any) : null;
      }
    } else {
      userRecord = await this.userRepository.findByPhoneOrEmail(
        customerIdentity ?? { phone: data.phone, email: data.email },
        'user'
      );
    }

    let userId: string;
    if (!userRecord) {
      if (data.userType === 'admin') {
        throw new AppError({
          status: 404,
          code: 'ADMIN_NOT_FOUND',
          message: 'Admin not found',
        });
      }
      if (data.userType === 'hr') {
        throw new AppError({
          status: 404,
          code: 'HR_NOT_FOUND',
          message: 'HR not found',
        });
      }
      if (data.userType === 'partner') {
        throw new AppError({
          status: 404,
          code: 'PARTNER_MEMBER_NOT_FOUND',
          message: 'No active partner membership found for this mobile number or email.',
        });
      }
      // Owner decision: accounts are created only by mobile number. An email no customer, doctor or pharmacy uses creates
      // nothing (it would be a second, empty account); the answer says the email is not registered (per-destination
      // send limits above still apply). The email is added to an account from its profile (email verification).
      const byEmail = data.userType === 'user' ? customerContact?.target === 'email' : !data.phone;
      if (byEmail && (data.userType === 'user' || data.userType === 'specialist' || data.userType === 'pharmacy')) {
        throw new AppError({ status: 404, code: 'EMAIL_NOT_REGISTERED',
          message: 'No account uses this email. Sign in with your mobile number, then add this email to your profile.' });
      }
      // Owner decision (19 Nov 2026): only admins create pharmacies, so an unknown number does not sign a pharmacy up.
      if (data.userType === 'pharmacy') {
        throw new AppError({ status: 404, code: 'PHARMACY_NOT_FOUND',
          message: "This mobile number isn't registered as a pharmacy. Ask the Jansetu team to add your pharmacy." });
      }
      if (data.userType === 'specialist') {
        const newSpecialist = await this.specialistRepository.save(
          this.buildSpecialistSignupPayload(data)
        );
        userId = newSpecialist._id!;
      }
      else {
        const newUser = await this.userRepository.save({
          ...(customerIdentity ?? { phone: data.phone, email: data.email }),
          userType: 'user',
          createdSource: 'self_signup',
          otpVerified: false,
        });
        userId = newUser._id!;
      }
    } else {
      if (data.userType === 'admin' && userRecord.isActive === false) {
        throw new AppError({
          status: 403,
          code: 'ADMIN_INACTIVE',
          message: 'Admin account is inactive',
        });
      }
      if (
        data.userType === 'specialist' &&
        (userRecord as ISpecialist).isActive === false
      ) {
        throw new AppError({
          status: 403,
          code: 'SPECIALIST_INACTIVE',
          message: 'Specialist account is inactive',
        });
      }
      if (data.userType === 'hr' && (userRecord as IHR).isActive === false) {
        throw new AppError({
          status: 403,
          code: 'HR_INACTIVE',
          message: 'HR account is inactive',
        });
      }
      if (data.userType === 'pharmacy' && (userRecord as IPharmacy).isActive === false) {
        throw new AppError({
          status: 403,
          code: 'PHARMACY_INACTIVE',
          message: 'Pharmacy account is inactive',
        });
      }
      if (data.userType === 'partner' && (userRecord as unknown as IMember).isActive === false) {
        throw new AppError({
          status: 403,
          code: 'PARTNER_MEMBER_INACTIVE',
          message: 'Partner membership is inactive',
        });
      }
      userId = userRecord._id!;
    }

    // Create OTP record using OTP service
    const target = customerContact?.target ?? (data.phone ? 'phone' : 'email');
    const targetValue = customerContact?.targetValue ?? (data.phone?.trim() || data.email?.trim().toLowerCase());
    await this.otpService.createOTP({
      userId,
      otp,
      target,
      targetValue,
    });

    const expiryMinutes = CONFIG.OTP_EXPIRY_MINUTES;
    if (target === 'phone' && data.phone) {
      const smsContent = this.smsService.buildSMSContent('otp', {
        otp,
        expiryMinutes,
      });
      await this.smsService.sendSMS({
        to: customerContact?.target === 'phone' ? customerContact.targetValue : data.phone,
        text: smsContent.text,
        templateId: smsContent.templateId,
      });
    } else if (target === 'email' && data.email) {
      const normalizedEmail = customerContact?.target === 'email'
        ? customerContact.targetValue
        : data.email.trim().toLowerCase();
      await this.emailService.sendEmail({
        to: [normalizedEmail],
        subject: 'MyEwaCare OTP Verification',
        textBody: `Your OTP for verification on MyEwaCare is ${otp}. This OTP is valid for ${expiryMinutes} minutes. Do not share this OTP with anyone.`,
      });
    }

    return { message: 'OTP sent successfully' };
  }

  verifyOTP = async (data: VerifyOTPRequest): Promise<{
    message: string;
    accessToken: string;
    userData: {
      _id: string;
      phone?: string;
      email?: string;
      corporateId?: string;
      specialistId?: string;
      pharmacyId?: string;
      memberId?: string;
      partnerId?: string;
      userType: string;
    };
    /** Q7: present (and no token) when a partner person must choose among several memberships. */
    selection?: { ticket: string; choices: { partnerId: string; name: string; kind: string; solo: boolean; role: string }[] };
  }> => {
    const customerContact = data.userType === 'user'
      ? selectCustomerLoginContact(data, true)
      : undefined;
    const customerIdentity: { phone?: string; email?: string } | undefined = customerContact
      ? { [customerContact.target]: customerContact.targetValue }
      : undefined;
    // Find identity record based on userType
    let userRecord: IUser | IAdmin | ISpecialist | IHR | IPharmacy | null;
    if (data.userType === 'admin') {
      userRecord = await this.adminRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'hr') {
      userRecord = await this.hrRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'specialist') {
      userRecord = await this.specialistRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'pharmacy') {
      userRecord = data.phone
        ? await this.pharmacyRepository.findByPhone(data.phone)
        : await this.pharmacyRepository.findByEmail(data.email!);
    } else if (data.userType === 'partner') {
      const members = await this.partnerMembersOf(data.phone ? { phone: data.phone } : { email: data.email });
      // Q7: with several memberships and no choice yet, the code is bound to the first membership (partnerId order,
      // the same at verify); after the code proves the phone, the person chooses (selectPartner).
      if (data.partnerId) {
        userRecord = (members.find(m => String((m as any).partnerId) === data.partnerId) as any) ?? null;
      } else {
        userRecord = members.length > 0 ? (members[0] as any) : null;
      }
    } else {
      userRecord = await this.userRepository.findByPhoneOrEmail(
        customerIdentity ?? { phone: data.phone, email: data.email },
        'user'
      );
    }

    if (!userRecord) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    if (
      'userType' in userRecord &&
      userRecord.userType === 'admin' &&
      userRecord.isActive === false
    ) {
      throw new AppError({
        status: 403,
        code: 'ADMIN_INACTIVE',
        message: 'Admin account is inactive',
      });
    }

    if (
      data.userType === 'specialist' &&
      (userRecord as ISpecialist).isActive === false
    ) {
      throw new AppError({
        status: 403,
        code: 'SPECIALIST_INACTIVE',
        message: 'Specialist account is inactive',
      });
    }
    if (data.userType === 'hr' && (userRecord as IHR).isActive === false) {
      throw new AppError({
        status: 403,
        code: 'HR_INACTIVE',
        message: 'HR account is inactive',
      });
    }
    if (data.userType === 'pharmacy' && (userRecord as IPharmacy).isActive === false) {
      throw new AppError({
        status: 403,
        code: 'PHARMACY_INACTIVE',
        message: 'Pharmacy account is inactive',
      });
    }

    // Verify OTP against the selected identity's current destination.
    const target = customerContact?.target ?? (data.phone ? 'phone' : 'email');
    const targetValue = target === 'phone'
      ? userRecord.phone?.trim()
      : userRecord.email?.trim().toLowerCase();
    if (!targetValue) {
      throw new AppError({
        status: 400,
        code: 'OTP_UNAVAILABLE',
        message: 'OTP is no longer available; request a new OTP',
      });
    }
    await this.otpService.verifyOTP({
      userId: userRecord._id!,
      otp: data.otp,
      target,
      targetValue,
    });

    // Q7: the phone (or email) is proven; a person with several memberships (and no choice yet) now chooses one.
    if (data.userType === 'partner' && !data.partnerId) {
      const identity: PartnerIdentity = target === 'phone' ? { phone: String(userRecord.phone) } : { email: String(userRecord.email).trim().toLowerCase() };
      const choices = await this.partnerChoices(identity);
      if (choices.length > 1) {
        return { message: 'Choose the workspace to open', accessToken: '', userData: { _id: '', userType: 'partner' },
          selection: { ticket: await this.issueSelectionTicket(identity), choices } };
      }
      if (choices.length === 1 && choices[0]!.partnerId !== String((userRecord as unknown as IMember).partnerId)) {
        // The proven membership's partner is inactive; the one active membership is the only choice.
        const only = (await this.partnerMembersOf(identity))
          .find((m) => String((m as any).partnerId) === choices[0]!.partnerId);
        if (!only) throw new AppError({ status: 403, code: 'PARTNER_INACTIVE', message: 'None of your partner workspaces is active' });
        userRecord = only as unknown as IUser;
      }
      if (choices.length === 0) {
        throw new AppError({ status: 403, code: 'PARTNER_INACTIVE', message: 'None of your partner workspaces is active' });
      }
    }

    // Create wallet for regular users (not admins) if it doesn't exist
    // getByUserId will auto-create the wallet if it doesn't exist
    if (
      'userType' in userRecord &&
      userRecord.userType === 'user'
    ) {
      await this.userRepository.update(
        { _id: userRecord._id! },
        { otpVerified: true, isVerified: true }
      );
      await this.walletService.getByUserId(userRecord._id!);
    }

    // Create login notification
    try {
      if ('userType' in userRecord && userRecord.userType === 'user') {
        await this.notificationService.createLoginNotification(userRecord._id!);
      } else if (data.userType === 'specialist') {
        await this.notificationService.createSpecialistLoginNotification(
          userRecord._id!
        );
      }
    } catch (error) {
      // Don't fail login if notification creation fails
      console.error('Failed to create login notification:', error);
    }

    const id = userRecord._id!;
    let tokenPayload: {
      _id: string;
      phone?: string;
      email?: string;
      corporateId?: string;
      specialistId?: string;
      pharmacyId?: string;
      memberId?: string;
      partnerId?: string;
      userType: string;
    };

    if (data.userType === 'partner') {
      const member = userRecord as unknown as IMember;
      tokenPayload = {
        _id: id,
        memberId: id,
        partnerId: member.partnerId,
        phone: member.phone,
        ...(member.email ? { email: member.email } : {}),
        userType: 'partner',
      };
    } else if (data.userType === 'pharmacy') {
      const pharmacy = userRecord as IPharmacy;
      tokenPayload = {
        _id: id,
        pharmacyId: id,
        phone: pharmacy.phone,
        email: pharmacy.email,
        userType: 'pharmacy',
      };
    } else if (data.userType === 'specialist') {
      tokenPayload = {
        _id: id,
        specialistId: id,
        phone: userRecord.phone,
        email: userRecord.email,
        userType: 'specialist',
      };
    } else if (data.userType === 'hr') {
      const hr = userRecord as IHR;
      tokenPayload = {
        _id: id,
        phone: hr.phone,
        email: hr.email,
        ...(hr.corporateId ? { corporateId: hr.corporateId } : {}),
        userType: 'hr',
      };
    } else if (
      'userType' in userRecord &&
      userRecord.userType === 'admin'
    ) {
      tokenPayload = {
        _id: id,
        phone: userRecord.phone,
        email: userRecord.email,
        userType: 'admin',
      };
    } else {
      const u = userRecord as IUser;
      tokenPayload = {
        _id: id,
        phone: u.phone,
        email: u.email,
        ...(u.corporateId ? { corporateId: u.corporateId } : {}),
        userType: 'user',
      };
    }

    // Customer tokens carry the account's credential generation, read after the OTP was consumed. If a "sign out
    // everywhere" commits in between, this token simply carries the old generation and is refused.
    let claims: typeof tokenPayload & { authVersion?: number } = tokenPayload;
    if (tokenPayload.userType === 'user') {
      const authVersion = await readCredentialVersion(String(id));
      if (authVersion === null || authVersion < 0) {
        throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Please sign in again' });
      }
      claims = { ...tokenPayload, authVersion };
    }
    const accessToken = jwt.sign(claims, CONFIG.JWT_SECRET_KEY, {
      expiresIn: '30d', // Token expires in 30 days
    });

    return {
      message: 'OTP verified successfully',
      accessToken,
      userData: tokenPayload,
    };
  };

  /** The active memberships signed in to with this phone or (lower-cased, exact) email, in partnerId order. */
  private async partnerMembersOf(identity: { phone?: string; email?: string }): Promise<IMember[]> {
    if (identity.phone) return this.memberRepository.findActiveByPhoneAcrossPartners(identity.phone);
    if (identity.email) return this.memberRepository.findActiveByEmailAcrossPartners(identity.email);
    return [];
  }

  /** Q7: the active memberships of a phone/email whose partner is active, in the order the sign-in uses. */
  private async partnerChoices(identity: PartnerIdentity): Promise<{ partnerId: string; name: string; kind: string; solo: boolean; role: string }[]> {
    const members = await this.partnerMembersOf(identity);
    const partners = await PartnerModel.find({ _id: { $in: members.map((m) => String((m as any).partnerId)) }, isActive: { $ne: false } })
      .select({ name: 1, kind: 1, solo: 1 }).lean() as any[];
    const byId = new Map(partners.map((p) => [String(p._id), p]));
    return members.filter((m) => byId.has(String((m as any).partnerId))).map((m) => {
      const p = byId.get(String((m as any).partnerId));
      return { partnerId: String((m as any).partnerId), name: p.name, kind: p.kind, solo: !!p.solo, role: (m as any).role };
    });
  }

  private async issueSelectionTicket(identity: PartnerIdentity): Promise<string> {
    const jti = randomUUID();
    const ttl = 5 * 60;
    await PartnerSelectionTicketModel.create({ jti, ...identity, expiresAt: new Date(Date.now() + ttl * 1000) });
    return jwt.sign({ purpose: 'partner_select', ...identity, jti }, selectionKey(), { expiresIn: ttl, audience: SELECTION_AUDIENCE });
  }

  /**
   * Q7: completes a partner sign-in with the chosen membership. The ticket (signed, 5 minutes, one use) stands for the
   * OTP the person already proved; the choice must be one of that phone's active memberships of an active partner.
   */
  selectPartner = async (data: { ticket: string; partnerId: string }) => {
    let claims: { purpose?: string; phone?: string; email?: string; jti?: string };
    try {
      claims = jwt.verify(data.ticket, selectionKey(), { audience: SELECTION_AUDIENCE }) as typeof claims;
    } catch {
      throw new AppError({ status: 401, code: 'SELECTION_EXPIRED', message: 'This sign-in expired; request a new code' });
    }
    // Exactly one proven identity: the phone, or the email of an email sign-in.
    const identity: PartnerIdentity | null = typeof claims.phone === 'string' && claims.phone && claims.email === undefined ? { phone: claims.phone }
      : typeof claims.email === 'string' && claims.email && claims.phone === undefined ? { email: claims.email } : null;
    if (claims.purpose !== 'partner_select' || !identity || !claims.jti) {
      throw new AppError({ status: 401, code: 'SELECTION_EXPIRED', message: 'This sign-in expired; request a new code' });
    }
    const claimed = await PartnerSelectionTicketModel.findOneAndDelete({ jti: claims.jti, ...identity, expiresAt: { $gt: new Date() } });
    if (!claimed) throw new AppError({ status: 401, code: 'SELECTION_EXPIRED', message: 'This sign-in expired; request a new code' });
    const choices = await this.partnerChoices(identity);
    if (!choices.some((c) => c.partnerId === String(data.partnerId))) {
      throw new AppError({ status: 403, code: 'PARTNER_NOT_AVAILABLE', message: 'That workspace is not available to you' });
    }
    const member = (await this.partnerMembersOf(identity))
      .find((m) => String((m as any).partnerId) === String(data.partnerId)) as unknown as IMember;
    const tokenPayload = { _id: String(member._id), memberId: String(member._id), partnerId: String(member.partnerId), phone: member.phone,
      ...(member.email ? { email: member.email } : {}), userType: 'partner' };
    const accessToken = jwt.sign(tokenPayload, CONFIG.JWT_SECRET_KEY, { expiresIn: '30d' });
    return { message: 'Signed in', accessToken, userData: tokenPayload };
  };

  async sendEmailVerificationOTP(
    userId: string,
    data: SendEmailVerificationOTPRequest
  ): Promise<{ message: string }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const normalizedEmail = this.normalizeEmail(data.email)!;
    this.assertPersonalEmailVerificationTarget(user.email, normalizedEmail);
    await this.ensureEmailAvailableAcrossUserFields(normalizedEmail, userId);

    if (data.isCorporateUser) {
      if (user.corporateId) {
        await this.verifyEmailDomain(normalizedEmail, user.corporateId);
      } else {
        const emailDomain = normalizedEmail.split('@')[1]?.toLowerCase();

        if (emailDomain) {
          const corporate = await this.corporateRepository.findOne({
            domain: emailDomain,
            isActive: true,
          } as any);

          if (!corporate) {
            throw new AppError({
              status: 400,
              code: 'CORPORATE_NOT_FOUND',
              message: `No corporate found for domain`,
            });
          }
        }
      }
    }

    await otpLimit('send-account', throttleId(`account|${userId}`), otpLimits.sendAccount());
    await otpLimit('send', destinationId('email', normalizedEmail), otpLimits.send());
    const otp = randomInt(100000, 1000000).toString();
    await this.otpService.createOTP({
      userId,
      otp,
      target: 'email',
      targetValue: normalizedEmail,
    });

    await this.emailService.sendEmail({
      to: [normalizedEmail],
      subject: 'Email Verification OTP',
      textBody: `Your OTP for email verification on MyEwaCare is ${otp}. This OTP is valid for ${CONFIG.OTP_EXPIRY_MINUTES} minutes. Do not share this OTP with anyone.`,
    });

    return { message: 'Email verification OTP sent successfully' };
  }

  async verifyEmailVerificationOTP(
    userId: string,
    data: VerifyEmailVerificationOTPRequest,
    tokenVersion = 0
  ): Promise<{ message: string; user: Partial<IUser>; accessToken: string }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    // An omitted target binds to the stored email (re-verification); a different one is refused before the OTP.
    const normalizedEmail = this.normalizeEmail(data.email) || this.normalizeEmail(user.email);
    this.assertPersonalEmailVerificationTarget(user.email, normalizedEmail);
    const verifiedOTP = await this.otpService.verifyOTP({
      userId,
      otp: data.otp,
      target: 'email',
      targetValue: normalizedEmail,
    });

    const verifiedEmail = verifiedOTP.targetValue?.trim().toLowerCase();
    if (!verifiedEmail) {
      throw new AppError({
        status: 400,
        code: 'EMAIL_VERIFICATION_NOT_INITIATED',
        message: 'Please request email verification OTP first',
      });
    }

    this.assertPersonalEmailVerificationTarget(user.email, verifiedEmail);

    let corporateIdToSet = user.corporateId;

    if (data.isCorporateUser) {
      // Apply corporate domain check for users already linked to a corporate profile
      if (user.corporateId) {
        await this.verifyEmailDomain(verifiedEmail, user.corporateId);
      } else {
        const emailDomain = verifiedEmail.split('@')[1]?.toLowerCase();
        if (emailDomain) {
          const corporate = await this.corporateRepository.findOne({
            domain: emailDomain,
            isActive: true,
          } as any);

          if (!corporate) {
            throw new AppError({
              status: 400,
              code: 'CORPORATE_NOT_FOUND',
              message: `No corporate found for domain`,
            });
          }

          if (corporate._id) {
            corporateIdToSet = corporate._id.toString();
          }
        }
      }
    }

    await this.ensureEmailAvailableAcrossUserFields(verifiedEmail, userId);

    const updateData: any = {
      email: verifiedEmail,
      isVerified: true,
    };
    if (data.isCorporateUser) {
      updateData.corporateEmail = verifiedEmail;
      updateData.isCorporateEmailVerified = true;
    }
    if (corporateIdToSet) {
      updateData.corporateId = corporateIdToSet;
    }

    // Fenced on the caller's credential generation: a session signed out meanwhile cannot change the email or get a
    // fresh token. The new token keeps that same generation (never the stored one).
    // Two fences in one write: the email observed above is unchanged (milestone F4: an email set or changed meanwhile
    // is not overwritten) and the caller's session is still at its credential generation (C1r).
    const updatedUser = await this.userRepository.update(
      {
        _id: userId,
        email: user.email === undefined ? { $exists: false } : user.email,
        $and: [
          { $expr: { $in: [{ $type: '$email' }, ['missing', 'null', 'string']] } },
          credentialFilter(tokenVersion),
        ],
      } as any,
      updateData
    );

    if (!updatedUser && await readCredentialVersion(userId) !== tokenVersion) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Please sign in again' });
    }
    if (!updatedUser) {
      throw new AppError({
        status: 409,
        code: 'CONTACT_CHANGED',
        message: 'Email changed; refresh the profile and request a new verification code',
      });
    }

    const tokenPayload = {
      _id: updatedUser._id!,
      phone: updatedUser.phone,
      email: updatedUser.email,
      ...(updatedUser.corporateId && { corporateId: updatedUser.corporateId }),
      userType: updatedUser.userType!,
    };

    const accessToken = jwt.sign({ ...tokenPayload, authVersion: tokenVersion }, CONFIG.JWT_SECRET_KEY, {
      expiresIn: '30d',
    });

    return {
      message: 'Email verified successfully',
      accessToken,
      user: updatedUser,
    };
  }

  async sendCorporateEmailVerificationOTP(
    userId: string,
    data: SendCorporateEmailVerificationOTPRequest
  ): Promise<{ message: string }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const normalizedEmail = this.normalizeEmail(data.corporateEmail)!;
    if (normalizedEmail === this.normalizeEmail(user.email)) {
      throw new AppError({
        status: 400,
        code: 'EMAILS_MUST_DIFFER',
        message: 'Personal email and corporate email must be different',
      });
    }

    await this.ensureEmailAvailableAcrossUserFields(normalizedEmail, userId);

    const emailDomain = normalizedEmail.split('@')[1]?.toLowerCase();
    if (!emailDomain) {
      throw new AppError({
        status: 400,
        code: 'INVALID_CORPORATE_EMAIL',
        message: 'Corporate email must be valid',
      });
    }

    const corporate = await this.corporateRepository.findOne({
      domain: emailDomain,
      isActive: true,
    } as any);

    if (!corporate) {
      throw new AppError({
        status: 400,
        code: 'CORPORATE_NOT_FOUND',
        message: 'No corporate found for domain',
      });
    }

    await otpLimit('send-account', throttleId(`account|${userId}`), otpLimits.sendAccount());
    await otpLimit('send', destinationId('email', normalizedEmail), otpLimits.send());
    const otp = randomInt(100000, 1000000).toString();
    await this.otpService.createOTP({
      userId,
      otp,
      target: 'email',
      targetValue: normalizedEmail,
    });

    await this.emailService.sendEmail({
      to: [normalizedEmail],
      subject: 'Corporate Email Verification OTP',
      textBody: `Your OTP for corporate email verification on MyEwaCare is ${otp}. This OTP is valid for ${CONFIG.OTP_EXPIRY_MINUTES} minutes. Do not share this OTP with anyone.`,
    });

    return { message: 'Corporate email verification OTP sent successfully' };
  }

  async verifyCorporateEmailVerificationOTP(
    userId: string,
    data: VerifyCorporateEmailVerificationOTPRequest,
    tokenVersion = 0
  ): Promise<{ message: string; user: Partial<IUser>; accessToken: string }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const normalizedEmail = this.normalizeEmail(data.corporateEmail);
    const verifiedOTP = await this.otpService.verifyOTP({
      userId,
      otp: data.otp,
      target: 'email',
      targetValue: normalizedEmail,
    });

    const verifiedCorporateEmail = this.normalizeEmail(verifiedOTP.targetValue);
    if (!verifiedCorporateEmail) {
      throw new AppError({
        status: 400,
        code: 'CORPORATE_EMAIL_VERIFICATION_NOT_INITIATED',
        message: 'Please request corporate email verification OTP first',
      });
    }

    if (verifiedCorporateEmail === this.normalizeEmail(user.email)) {
      throw new AppError({
        status: 400,
        code: 'EMAILS_MUST_DIFFER',
        message: 'Personal email and corporate email must be different',
      });
    }

    await this.ensureEmailAvailableAcrossUserFields(
      verifiedCorporateEmail,
      userId
    );

    const emailDomain = verifiedCorporateEmail.split('@')[1]?.toLowerCase();
    const corporate = emailDomain
      ? await this.corporateRepository.findOne({
          domain: emailDomain,
          isActive: true,
        } as any)
      : null;

    if (!corporate || !corporate._id) {
      throw new AppError({
        status: 400,
        code: 'CORPORATE_NOT_FOUND',
        message: 'No corporate found for domain',
      });
    }

    const updatedUser = await this.userRepository.update(
      { _id: userId, ...credentialFilter(tokenVersion) } as any,
      {
        corporateEmail: verifiedCorporateEmail,
        isCorporateEmailVerified: true,
        corporateId: corporate._id.toString(),
      } as any
    );

    if (!updatedUser && await readCredentialVersion(userId) !== tokenVersion) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Please sign in again' });
    }
    if (!updatedUser) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update corporate email',
      });
    }

    const tokenPayload = {
      _id: updatedUser._id!,
      phone: updatedUser.phone,
      email: updatedUser.email,
      ...(updatedUser.corporateId && { corporateId: updatedUser.corporateId }),
      userType: updatedUser.userType!,
    };

    const accessToken = jwt.sign({ ...tokenPayload, authVersion: tokenVersion }, CONFIG.JWT_SECRET_KEY, {
      expiresIn: '30d',
    });

    return {
      message: 'Corporate email verified successfully',
      accessToken,
      user: updatedUser,
    };
  }

  /**
   * Sign out on every device (C1 revoke-only): advances the customer's credential generation from the caller's own
   * token generation, so every token issued so far (this one included) stops working. The customer signs in again
   * with the normal OTP login.
   */
  async revokeSessions(actor: { _id?: unknown; userType?: unknown; authVersion?: unknown } | undefined) {
    if (!actor || actor.userType !== 'user') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Individual customer access required' });
    if (typeof actor._id !== 'string') throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Please sign in again' });
    const version = tokenCredentialVersion(actor);
    if (!(await advanceCredentialVersion(actor._id, version))) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Please sign in again' });
    }
    return { signedOutEverywhere: true as const, reauthenticationRequired: true as const };
  }

  private async verifyEmailDomain(email: string, corporateId?: string): Promise<void> {
    if (!corporateId) return;

    const corporate = await this.corporateRepository.findById(corporateId);
    if (!corporate || !corporate.domain) return;

    const emailDomain = email.split('@')[1]?.toLowerCase();
    if (emailDomain !== corporate.domain.toLowerCase()) {
      throw new AppError({
        status: 400,
        code: 'EMAIL_DOMAIN_MISMATCH',
        message: `Email domain does not match corporate domain. Expected @${corporate.domain}`,
      });
    }
  }
}
