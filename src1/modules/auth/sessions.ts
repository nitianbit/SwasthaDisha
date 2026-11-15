import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import UserModel from '@/modules/user/model';
import AdminModel from '@/modules/admin/model';
import HRModel from '@/modules/hr/model';
import SpecialistModel from '@/modules/specialists/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { readCredentialVersion } from '@/modules/user/credentialGeneration';
import { AuthSessionModel, type AuthSession } from './model/session';

/**
 * D4 — web sessions that survive a reload. Design: documentation/planning/implementation/D4_COOKIE_SESSIONS.md.
 * A login creates a family row; the browser holds an HttpOnly refresh cookie (first-party: the web app's own host
 * forwards /api to the backend) and a 15-minute access JWT in memory carrying `sid`, `aud` and `auth_time`.
 */

export type WebAudience = 'customer' | 'workspace';
/** N1: the phone apps (Capacitor shell) keep their refresh token in the OS secure store, not in a cookie. */
export type NativeAudience = 'native_customer' | 'native_workspace';
export type Audience = WebAudience | NativeAudience;
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIFETIME: Record<Audience, { idle: number; absolute: number }> = {
  customer: { idle: 14 * DAY, absolute: 30 * DAY },
  workspace: { idle: 12 * HOUR, absolute: 7 * DAY },
  // N1: a phone stays signed in longer than a browser (customers); staff keep the web limits.
  native_customer: { idle: 30 * DAY, absolute: 90 * DAY },
  native_workspace: { idle: 12 * HOUR, absolute: 7 * DAY },
};
const AUDIENCE_ROLES: Record<Audience, readonly string[]> = {
  customer: ['user'],
  workspace: ['admin', 'pharmacy', 'hr', 'specialist'],
  native_customer: ['user'],
  native_workspace: ['admin', 'pharmacy', 'hr', 'specialist'],
};
export const SESSION_HEADER = 'x-jansetu-session';
export const NATIVE_HEADER = 'x-jansetu-native';
/** N1: a retried refresh whose answer was lost (flaky mobile network) gets the same new token within this window. */
export const NATIVE_RETRY_GRACE_MS = 30_000;

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function origins(): Record<WebAudience, string[]> {
  return { customer: list(CONFIG.SESSION_ORIGINS_CUSTOMER), workspace: list(CONFIG.SESSION_ORIGINS_WORKSPACE) };
}
/** Every origin allowed to use cookie sessions (also the only origins CORS gives credentials to). */
export function sessionOrigins(): string[] {
  const o = origins();
  return [...o.customer, ...o.workspace];
}

/** Development only (explicit flag): cookies without `__Host-`/`Secure` for http://127.0.0.1 dev servers. */
function insecureDev(): boolean {
  return CONFIG.NODE_ENV === 'development' && CONFIG.SESSION_COOKIE_INSECURE_DEV === true;
}
export function assertSessionConfig(): void {
  if (CONFIG.SESSION_COOKIE_INSECURE_DEV === true && CONFIG.NODE_ENV !== 'development') {
    throw new Error('SESSION_COOKIE_INSECURE_DEV is allowed only when NODE_ENV=development');
  }
}
function cookieName(audience: WebAudience): string {
  const base = audience === 'customer' ? 'sd_rt' : 'sd_staff_rt';
  return insecureDev() ? base : `__Host-${base}`;
}

const forbidden = (message: string) => new AppError({ status: 403, code: 'SESSION_ORIGIN_REFUSED', message });
const unauthorised = () => new AppError({ status: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });

/**
 * Login CSRF / audience gate for every session command. Fails closed: the Origin must be exactly one of the configured
 * web origins, the custom header must be present (a cross-site form cannot send it, a cross-site fetch needs a refused
 * preflight) and the body JSON. The audience comes from the Origin, never from the request.
 */
export function sessionAudience(req: Request): WebAudience {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin || origin === 'null') throw forbidden('This request must come from the Jansetu web app');
  if (req.headers[SESSION_HEADER] !== '1') throw forbidden('This request must come from the Jansetu web app');
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw forbidden('This request must come from the Jansetu web app');
  }
  const o = origins();
  if (o.customer.includes(origin)) return 'customer';
  if (o.workspace.includes(origin)) return 'workspace';
  throw forbidden('This request must come from the Jansetu web app');
}

export function assertRoleForAudience(audience: Audience, userType: string): void {
  if (!AUDIENCE_ROLES[audience].includes(userType)) {
    throw new AppError({ status: 403, code: 'SESSION_ROLE_REFUSED', message: 'This account cannot sign in to this app' });
  }
}

/** Refresh token = `sid.gen.mac`; mac = HMAC-SHA256(key derived from the server secret, `sid.gen`). */
const refreshKey = () => createHash('sha256').update(`${CONFIG.JWT_SECRET_KEY}:d4-refresh-v1`).digest();
const mac = (sid: string, gen: number) => createHmac('sha256', refreshKey()).update(`${sid}.${gen}`).digest('base64url');
const refreshToken = (sid: string, gen: number) => `${sid}.${gen}.${mac(sid, gen)}`;
/** The family and generation of a correctly signed refresh token, or null (unsigned identifiers prove nothing). */
function parseRefresh(token: string | null): { sid: string; gen: number } | null {
  const m = token ? /^([0-9a-f]{32})\.([1-9][0-9]{0,8})\.([A-Za-z0-9_-]{43})$/.exec(token) : null;
  if (!m) return null;
  const sid = m[1]!; const gen = Number(m[2]);
  const want = Buffer.from(mac(sid, gen)); const got = Buffer.from(m[3]!);
  return want.length === got.length && timingSafeEqual(want, got) ? { sid, gen } : null;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_.-]{20,120}$/.test(v) ? v : null;
    }
  }
  return null;
}

function setCookie(res: Response, audience: WebAudience, token: string, maxAgeMs: number): void {
  const secure = insecureDev() ? '' : '; Secure';
  res.append('Set-Cookie', `${cookieName(audience)}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
}
export function clearCookie(res: Response, audience: WebAudience): void {
  const secure = insecureDev() ? '' : '; Secure';
  res.append('Set-Cookie', `${cookieName(audience)}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0`);
}
/** Token responses are never cached and differ per cookie. */
export function privateTokenResponse(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.vary('Cookie');
}

type Claims = Record<string, unknown> & { _id: string; userType: string; authVersion?: number };

function accessToken(claims: Claims, session: Pick<AuthSession, '_id' | 'audience' | 'authTime'>): string {
  const { iat: _i, exp: _e, ...rest } = claims as Claims & { iat?: number; exp?: number };
  return jwt.sign({ ...rest, sid: session._id, aud: session.audience, auth_time: Math.floor(session.authTime.getTime() / 1000) },
    CONFIG.JWT_SECRET_KEY, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

/**
 * Creates a family in the request that consumed the OTP; sets the cookie; returns the access token. The family this
 * browser held before (its correctly signed cookie, if any) is revoked first: a fresh sign-in replaces it, so no tab
 * can keep using the old family's tokens beyond the next sign-out.
 */
export async function createSession(res: Response, audience: WebAudience, claims: Claims, now = new Date(), req?: Request): Promise<string> {
  assertRoleForAudience(audience, claims.userType);
  const previous = req ? parseRefresh(readCookie(req, cookieName(audience))) : null;
  if (previous) await revokeFamily(previous.sid, 'replaced_by_new_sign_in');
  const { session, token } = await newFamily(audience, claims, now);
  setCookie(res, audience, token, LIFETIME[audience].idle);
  return accessToken(claims, session);
}

async function newFamily(audience: Audience, claims: Claims, now: Date): Promise<{ session: AuthSession; token: string }> {
  const life = LIFETIME[audience];
  const sid = randomBytes(16).toString('hex');
  const session = await AuthSessionModel.create({
    _id: sid, audience, userType: claims.userType, userId: String(claims._id), authTime: now,
    absoluteExpiresAt: new Date(now.getTime() + life.absolute), idleExpiresAt: new Date(now.getTime() + life.idle),
    gen: 1, createdAt: now,
    ...(claims.userType === 'user' ? { authVersion: Number(claims.authVersion ?? 0) } : {}),
  });
  return { session: session.toObject() as AuthSession, token: refreshToken(sid, 1) };
}

/** The account behind a session is still allowed in (checked on every refresh). */
async function accountStillAllowed(s: AuthSession): Promise<Claims | null> {
  const id = s.userId;
  switch (s.userType) {
    case 'user': {
      const version = await readCredentialVersion(id);
      if (version === null || version !== Number(s.authVersion ?? 0)) return null;
      const u = await UserModel.findById(id).lean() as { phone?: string; email?: string; corporateId?: unknown; isActive?: boolean } | null;
      if (!u || u.isActive === false) return null;
      return { _id: id, phone: u.phone, email: u.email, ...(u.corporateId ? { corporateId: String(u.corporateId) } : {}), userType: 'user', authVersion: version };
    }
    case 'admin': {
      const a = await AdminModel.findById(id).lean() as { phone?: string; email?: string; isActive?: boolean } | null;
      return a && a.isActive !== false ? { _id: id, phone: a.phone, email: a.email, userType: 'admin' } : null;
    }
    case 'hr': {
      const h = await HRModel.findById(id).lean() as { phone?: string; email?: string; isActive?: boolean; corporateId?: unknown } | null;
      return h && h.isActive !== false ? { _id: id, phone: h.phone, email: h.email, ...(h.corporateId ? { corporateId: String(h.corporateId) } : {}), userType: 'hr' } : null;
    }
    case 'specialist': {
      const sp = await SpecialistModel.findById(id).lean() as { phone?: string; email?: string; isActive?: boolean } | null;
      return sp && sp.isActive !== false ? { _id: id, specialistId: id, phone: sp.phone, email: sp.email, userType: 'specialist' } : null;
    }
    case 'pharmacy': {
      const p = await PharmacyModel.findById(id).lean() as { phone?: string; email?: string; isActive?: boolean; archivedAt?: Date } | null;
      return p && p.isActive !== false && !p.archivedAt ? { _id: id, pharmacyId: id, phone: p.phone, email: p.email, userType: 'pharmacy' } : null;
    }
    default:
      return null;
  }
}

async function revokeFamily(id: string, reason: string): Promise<void> {
  await AuthSessionModel.updateOne({ _id: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokeReason: reason } });
}

/**
 * Rotates the refresh cookie: a compare-and-set on the family's current generation. A correctly signed token of an
 * OLDER generation is reuse (the family ends); anything unsigned or unknown is just refused.
 */
export async function refreshSession(req: Request, res: Response, now = new Date()):
  Promise<{ token: string; expiresIn: number; principal: { userId: string; userType: string; sid: string } }> {
  const audience = sessionAudience(req);
  const presented = parseRefresh(readCookie(req, cookieName(audience)));
  if (!presented) { clearCookie(res, audience); throw unauthorised(); }
  const life = LIFETIME[audience];
  const rotated = await AuthSessionModel.findOneAndUpdate(
    { _id: presented.sid, gen: presented.gen, audience, revokedAt: { $exists: false }, absoluteExpiresAt: { $gt: now }, idleExpiresAt: { $gt: now } },
    [{ $set: { gen: { $add: ['$gen', 1] }, lastRefreshAt: now,
      idleExpiresAt: { $min: [new Date(now.getTime() + life.idle), '$absoluteExpiresAt'] } } }],
    { new: true },
  ).lean() as AuthSession | null;
  if (!rotated) {
    const row = await AuthSessionModel.findById(presented.sid).select({ gen: 1, audience: 1 }).lean();
    if (row && row.audience === audience && Number(row.gen) > presented.gen) await revokeFamily(presented.sid, 'reuse_detected');
    clearCookie(res, audience);
    throw unauthorised();
  }
  const claims = await accountStillAllowed(rotated);
  if (!claims) {
    await revokeFamily(rotated._id, 'account_changed');
    clearCookie(res, audience);
    throw unauthorised();
  }
  setCookie(res, audience, refreshToken(rotated._id, rotated.gen), rotated.idleExpiresAt.getTime() - now.getTime());
  return { token: accessToken(claims, rotated), expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    principal: { userId: rotated.userId, userType: rotated.userType, sid: rotated._id } };
}

/** Ends this browser's session (idempotent) and clears its cookie. */
export async function logoutSession(req: Request, res: Response): Promise<void> {
  const audience = sessionAudience(req);
  const presented = parseRefresh(readCookie(req, cookieName(audience)));
  if (presented) {
    await AuthSessionModel.updateOne({ _id: presented.sid, audience, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokeReason: 'logout' } });
  }
  // The family of the access token the tab was using is ended too (it may differ from the cookie's after another
  // sign-in in this browser). Only a valid token, only its own family, only in this audience.
  const header = req.headers.authorization;
  type BearerClaims = { sid?: unknown; aud?: unknown; _id?: unknown; userType?: unknown };
  let bearer: BearerClaims | null = null;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    try {
      bearer = jwt.verify(header.slice(7), CONFIG.JWT_SECRET_KEY) as unknown as BearerClaims;
    } catch { bearer = null; /* an invalid or expired token ends nothing */ }
  }
  // A failure to revoke a valid token's family is an error (never a successful-looking logout).
  if (bearer && typeof bearer.sid === 'string' && bearer.aud === audience) {
    await AuthSessionModel.updateOne({ _id: bearer.sid, audience, userId: String(bearer._id), userType: String(bearer.userType), revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokeReason: 'logout' } });
  }
  clearCookie(res, audience);
}

/**
 * A replacement token for an already signed-in caller (e.g. after proving an email): a session-bound caller gets a
 * session-bound, 15-minute token with the SAME sid, audience and auth_time - never a long-lived unbound one. Legacy
 * (sid-less) callers keep the legacy token.
 */
export function reissueForCaller(caller: { sid?: unknown; aud?: unknown; auth_time?: unknown } | undefined, legacyToken: string): string {
  if (!caller || typeof caller.sid !== 'string') return legacyToken;
  const claims = jwt.decode(legacyToken) as Claims;
  const { iat: _i, exp: _e, ...rest } = claims as Claims & { iat?: number; exp?: number };
  return jwt.sign({ ...rest, sid: caller.sid, aud: caller.aud, auth_time: caller.auth_time }, CONFIG.JWT_SECRET_KEY, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

/** "Sign out everywhere": every session of this account ends. */
export async function revokeAllSessions(userType: string, userId: string, reason = 'signed_out_everywhere'): Promise<number> {
  const r = await AuthSessionModel.updateMany({ userType, userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date(), revokeReason: reason } });
  return r.modifiedCount;
}

/**
 * Access tokens that carry a session id are admitted only while that session is live: logout and revocation take
 * effect at once, not when the 15-minute token expires. Tokens without `sid` (legacy bearer) are unaffected.
 */
export async function admitSessionToken(claims: { sid?: unknown; aud?: unknown; userType?: unknown; _id?: unknown } | undefined): Promise<void> {
  if (!claims || claims.sid === undefined) return;
  if (typeof claims.sid !== 'string') throw unauthorised();
  const now = new Date();
  const live = await AuthSessionModel.exists({ _id: claims.sid, userId: String(claims._id), userType: String(claims.userType),
    audience: claims.aud, revokedAt: { $exists: false }, absoluteExpiresAt: { $gt: now }, idleExpiresAt: { $gt: now } });
  if (!live) throw unauthorised();
}

/* ------------------------------------------------------------------------------------------------------------------
 * N1 - native (phone app) sessions. Same families, rotation, reuse detection, account checks and per-request admission
 * as the web; the refresh token travels in the JSON body and lives in the OS secure store. No cookie, so no login
 * CSRF: the app header and JSON body only mark the request as the app's, and the audience is named in the body.
 * ---------------------------------------------------------------------------------------------------------------- */

const nativeRefused = () => new AppError({ status: 403, code: 'NATIVE_SESSION_REFUSED', message: 'This request must come from the Jansetu app' });

/** The native audience a request asks for: `X-Jansetu-Native: 1`, a JSON body and `app: 'customer' | 'workspace'`. */
export function nativeAudience(req: Request): NativeAudience {
  if (req.headers[NATIVE_HEADER] !== '1') throw nativeRefused();
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw nativeRefused();
  const app = (req.body as { app?: unknown } | undefined)?.app;
  if (app === 'customer') return 'native_customer';
  if (app === 'workspace') return 'native_workspace';
  throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'app must be customer or workspace' });
}

export interface NativeTokens {
  token: string;
  expiresIn: number;
  /** Keep in the OS secure store only; send back to /auth/session/native/refresh. Replaced on every refresh. */
  refreshToken: string;
  /** Seconds until the refresh token stops working if unused (idle limit, never past the absolute limit). */
  refreshExpiresIn: number;
}

/**
 * Starts a native family in the request that consumed the OTP. A refresh token the app still holds (`previous`, e.g.
 * from an account it is replacing) ends its family first, when it is correctly signed and native.
 */
export async function createNativeSession(audience: NativeAudience, claims: Claims, previous?: unknown, now = new Date()): Promise<NativeTokens> {
  assertRoleForAudience(audience, claims.userType);
  const prior = typeof previous === 'string' ? parseRefresh(previous) : null;
  if (prior) {
    await AuthSessionModel.updateOne({ _id: prior.sid, audience: { $in: ['native_customer', 'native_workspace'] }, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokeReason: 'replaced_by_new_sign_in' } });
  }
  const { session, token } = await newFamily(audience, claims, now);
  return { token: accessToken(claims, session), expiresIn: ACCESS_TOKEN_TTL_SECONDS, refreshToken: token,
    refreshExpiresIn: Math.floor(LIFETIME[audience].idle / 1000) };
}

/**
 * Rotates a native refresh token (compare-and-set on the generation, as on the web). One difference, for phones whose
 * answer can be lost on a flaky network: presenting the IMMEDIATELY previous generation within NATIVE_RETRY_GRACE_MS of
 * its rotation returns the current refresh token again (deterministic, nothing stored) instead of ending the family.
 * Any older generation, or the previous one after the grace window, is reuse: the family ends.
 */
export async function refreshNativeSession(req: Request, now = new Date()):
  Promise<NativeTokens & { principal: { userId: string; userType: string; sid: string } }> {
  const audience = nativeAudience(req);
  const raw = (req.body as { refreshToken?: unknown }).refreshToken;
  const presented = typeof raw === 'string' ? parseRefresh(raw) : null;
  if (!presented) throw unauthorised();
  const life = LIFETIME[audience];
  const live = { audience, revokedAt: { $exists: false }, absoluteExpiresAt: { $gt: now }, idleExpiresAt: { $gt: now } };
  let current = await AuthSessionModel.findOneAndUpdate(
    { _id: presented.sid, gen: presented.gen, ...live },
    [{ $set: { gen: { $add: ['$gen', 1] }, lastRefreshAt: now,
      idleExpiresAt: { $min: [new Date(now.getTime() + life.idle), '$absoluteExpiresAt'] } } }],
    { new: true },
  ).lean() as AuthSession | null;
  if (!current) {
    const row = await AuthSessionModel.findById(presented.sid).lean() as AuthSession | null;
    const retry = row && row.audience === audience && !row.revokedAt && row.gen === presented.gen + 1
      && row.lastRefreshAt && now.getTime() - row.lastRefreshAt.getTime() <= NATIVE_RETRY_GRACE_MS
      && row.absoluteExpiresAt > now && row.idleExpiresAt > now;
    if (retry) {
      current = row;
    } else {
      if (row && row.audience === audience && Number(row.gen) > presented.gen) await revokeFamily(presented.sid, 'reuse_detected');
      throw unauthorised();
    }
  }
  const claims = await accountStillAllowed(current);
  if (!claims) {
    await revokeFamily(current._id, 'account_changed');
    throw unauthorised();
  }
  return {
    token: accessToken(claims, current), expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: refreshToken(current._id, current.gen),
    refreshExpiresIn: Math.max(0, Math.floor((current.idleExpiresAt.getTime() - now.getTime()) / 1000)),
    principal: { userId: current.userId, userType: current.userType, sid: current._id },
  };
}

/** Ends the app's family (by its refresh token) and the family of the access token it sends. Idempotent. */
export async function logoutNativeSession(req: Request): Promise<void> {
  const audience = nativeAudience(req);
  const raw = (req.body as { refreshToken?: unknown }).refreshToken;
  const presented = typeof raw === 'string' ? parseRefresh(raw) : null;
  if (presented) {
    await AuthSessionModel.updateOne({ _id: presented.sid, audience, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokeReason: 'logout' } });
  }
  const header = req.headers.authorization;
  type BearerClaims = { sid?: unknown; aud?: unknown; _id?: unknown; userType?: unknown };
  let bearer: BearerClaims | null = null;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    try { bearer = jwt.verify(header.slice(7), CONFIG.JWT_SECRET_KEY) as unknown as BearerClaims; } catch { bearer = null; }
  }
  if (bearer && typeof bearer.sid === 'string' && bearer.aud === audience) {
    await AuthSessionModel.updateOne({ _id: bearer.sid, audience, userId: String(bearer._id), userType: String(bearer.userType), revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokeReason: 'logout' } });
  }
}
