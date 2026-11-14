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

export type Audience = 'customer' | 'workspace';
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIFETIME: Record<Audience, { idle: number; absolute: number }> = {
  customer: { idle: 14 * DAY, absolute: 30 * DAY },
  workspace: { idle: 12 * HOUR, absolute: 7 * DAY },
};
const AUDIENCE_ROLES: Record<Audience, readonly string[]> = {
  customer: ['user'],
  workspace: ['admin', 'pharmacy', 'hr', 'specialist'],
};
export const SESSION_HEADER = 'x-jansetu-session';

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function origins(): Record<Audience, string[]> {
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
function cookieName(audience: Audience): string {
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
export function sessionAudience(req: Request): Audience {
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

function setCookie(res: Response, audience: Audience, token: string, maxAgeMs: number): void {
  const secure = insecureDev() ? '' : '; Secure';
  res.append('Set-Cookie', `${cookieName(audience)}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
}
export function clearCookie(res: Response, audience: Audience): void {
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
export async function createSession(res: Response, audience: Audience, claims: Claims, now = new Date(), req?: Request): Promise<string> {
  assertRoleForAudience(audience, claims.userType);
  const previous = req ? parseRefresh(readCookie(req, cookieName(audience))) : null;
  if (previous) await revokeFamily(previous.sid, 'replaced_by_new_sign_in');
  const life = LIFETIME[audience];
  const sid = randomBytes(16).toString('hex');
  const token = refreshToken(sid, 1);
  const session = await AuthSessionModel.create({
    _id: sid, audience, userType: claims.userType, userId: String(claims._id), authTime: now,
    absoluteExpiresAt: new Date(now.getTime() + life.absolute), idleExpiresAt: new Date(now.getTime() + life.idle),
    gen: 1, createdAt: now,
    ...(claims.userType === 'user' ? { authVersion: Number(claims.authVersion ?? 0) } : {}),
  });
  setCookie(res, audience, token, life.idle);
  return accessToken(claims, session);
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
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    try {
      const c = jwt.verify(header.slice(7), CONFIG.JWT_SECRET_KEY) as { sid?: unknown; aud?: unknown; _id?: unknown; userType?: unknown };
      if (typeof c.sid === 'string' && c.aud === audience) {
        await AuthSessionModel.updateOne({ _id: c.sid, audience, userId: String(c._id), userType: String(c.userType), revokedAt: { $exists: false } },
          { $set: { revokedAt: new Date(), revokeReason: 'logout' } });
      }
    } catch { /* an invalid or expired token ends nothing */ }
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
