/**
 * Hits specialist auth + portal APIs; writes api-test.json (repo root).
 * Run with server up: npx tsx test/specialist-portal-api-test.ts
 *
 * If MONGODB_URL is set (e.g. via .env) and this specialist has no consultations,
 * inserts a temporary user + consultation booking so PATCH status and patient
 * history are exercised, then removes them.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';

const BASE =
  process.env.API_TEST_BASE_URL?.replace(/\/$/, '') || 'http://localhost:4030';

const SPECIALIST_PHONE = '9812300065';
const SPECIALIST_EMAIL = 'drantognanadelasallem65@example.com';

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function yyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Safe for committing api-test.json */
function redactForOutput(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactForOutput);
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'token' || k === 'authorization' || k === 'Authorization') {
        next[k] = '[REDACTED]';
      } else {
        next[k] = redactForOutput(v);
      }
    }
    return next;
  }
  return value;
}

type SeedResult = {
  bookingId: string;
  userId: string;
  cleanup: () => Promise<void>;
};

async function seedConsultationBooking(
  mongoUrl: string,
  specialistId: string,
  bookingDate: string
): Promise<SeedResult | null> {
  const conn = await mongoose.createConnection(mongoUrl).asPromise();
  try {
    const db = conn.db;
    if (!db) return null;

    const phoneSuffix = String(Date.now()).slice(-9);
    const phone = `1${phoneSuffix}`;

    const userRes = await db.collection('users').insertOne({
      userType: 'user',
      phone,
      name: 'API test seed patient',
      isActive: true,
      isVerified: false,
      country: 'India',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const userId = userRes.insertedId.toString();

    const bookRes = await db.collection('bookings').insertOne({
      bookingType: 'consultation',
      userId,
      specialistId: String(specialistId),
      bookingDate,
      bookingTime: '10:00 AM',
      serviceMode: 'video',
      price: 1,
      status: 'pending',
      paymentStatus: 'pending',
      documents: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const bookingId = bookRes.insertedId.toString();

    return {
      bookingId,
      userId,
      cleanup: async () => {
        const c = await mongoose.createConnection(mongoUrl).asPromise();
        try {
          await c.db?.collection('bookings').deleteOne({
            _id: new mongoose.Types.ObjectId(bookingId),
          });
          await c.db?.collection('users').deleteOne({
            _id: new mongoose.Types.ObjectId(userId),
          });
        } finally {
          await c.close();
        }
      },
    };
  } catch {
    return null;
  } finally {
    await conn.close();
  }
}

async function main() {
  const out: Record<string, unknown> = {
    meta: {
      baseUrl: BASE,
      specialistPhone: SPECIALIST_PHONE,
      specialistEmail: SPECIALIST_EMAIL,
      testedAt: new Date().toISOString(),
    },
    results: {} as Record<string, unknown>,
  };

  const results = out.results as Record<string, unknown>;

  const push = (name: string, status: number, body: unknown) => {
    results[name] = { httpStatus: status, body };
  };

  // 1) Send OTP (phone)
  let res = await fetch(`${BASE}/api/v1/auth/specialist/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: SPECIALIST_PHONE }),
  });
  push('auth_specialist_send_phone', res.status, await readJson(res));

  // 2) Verify OTP (test OTP 123456)
  res = await fetch(`${BASE}/api/v1/auth/specialist/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: SPECIALIST_PHONE, otp: '123456' }),
  });
  const verifyBody = (await readJson(res)) as {
    data?: { token?: string; user?: { _id?: string } };
  };
  const token = verifyBody?.data?.token;
  push(
    'auth_specialist_verify_phone',
    res.status,
    redactForOutput(verifyBody)
  );
  if (!token) {
    out.error =
      'No token from verify — ensure server is running, DB has specialist, OTP 123456 enabled.';
    fs.writeFileSync(
      path.resolve(process.cwd(), 'api-test.json'),
      JSON.stringify(out, null, 2),
      'utf8'
    );
    process.exit(1);
  }

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // 3) Profile
  res = await fetch(`${BASE}/api/v1/auth/profile`, { headers: authHeaders });
  const profileBody = (await readJson(res)) as {
    data?: { user?: { _id?: string } };
  };
  push('auth_profile', res.status, profileBody);
  const specialistId = profileBody?.data?.user?._id;

  // 4) List slots
  res = await fetch(`${BASE}/api/v1/specialist/slots`, { headers: authHeaders });
  push('specialist_slots_list', res.status, await readJson(res));

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 7);
  const slotDate = yyyymmdd(tomorrow);

  // 5) Create slot
  res = await fetch(`${BASE}/api/v1/specialist/slots`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      date: slotDate,
      startTime: '10:00 AM',
      endTime: '11:00 AM',
      duration: 60,
      maxBookings: 1,
      isActive: true,
      isAvailable: true,
    }),
  });
  const createSlotBody = (await readJson(res)) as { data?: { _id?: string } };
  push('specialist_slots_create', res.status, createSlotBody);

  const slotId = createSlotBody?.data?._id;

  // 6) List slots with date filter
  res = await fetch(
    `${BASE}/api/v1/specialist/slots?date=${slotDate}`,
    { headers: authHeaders }
  );
  push('specialist_slots_list_by_date', res.status, await readJson(res));

  // 7) Update slot
  if (slotId) {
    res = await fetch(`${BASE}/api/v1/specialist/slots/${slotId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ endTime: '11:30 AM' }),
    });
    push('specialist_slots_update', res.status, await readJson(res));
  } else {
    results.specialist_slots_update = {
      skipped: true,
      reason: 'create slot did not return _id',
    };
  }

  // 8) Appointments — day / month / all
  const today = yyyymmdd(new Date());
  const yearMonth = today.slice(0, 6);

  res = await fetch(
    `${BASE}/api/v1/specialist/appointments?view=day&date=${today}`,
    { headers: authHeaders }
  );
  push('specialist_appointments_day', res.status, await readJson(res));

  res = await fetch(
    `${BASE}/api/v1/specialist/appointments?view=month&yearMonth=${yearMonth}`,
    { headers: authHeaders }
  );
  push('specialist_appointments_month', res.status, await readJson(res));

  res = await fetch(
    `${BASE}/api/v1/specialist/appointments?view=all&page=1&limit=10`,
    { headers: authHeaders }
  );
  const allAppts = (await readJson(res)) as {
    data?: Array<{ _id?: string; userId?: string }>;
  };
  push('specialist_appointments_all', res.status, allAppts);

  let firstBooking = allAppts?.data?.[0];
  let seedCleanup: (() => Promise<void>) | undefined;

  const mongoUrl = process.env.MONGODB_URL;
  if (!firstBooking?._id && specialistId && mongoUrl) {
    const seeded = await seedConsultationBooking(
      mongoUrl,
      specialistId,
      today
    );
    if (seeded) {
      (out.meta as Record<string, unknown>).seededTempConsultation = {
        bookingId: seeded.bookingId,
        userId: seeded.userId,
      };
      seedCleanup = seeded.cleanup;
      firstBooking = { _id: seeded.bookingId, userId: seeded.userId };
    } else {
      (out.meta as Record<string, unknown>).seedConsultationFailed =
        'Seed skipped or failed (DB unreachable or insert error).';
    }
  }

  // 9) Patch appointment status (first booking if any)
  if (firstBooking?._id) {
    res = await fetch(
      `${BASE}/api/v1/specialist/appointments/${firstBooking._id}/status`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ status: 'confirmed' }),
      }
    );
    push(
      'specialist_appointments_patch_status',
      res.status,
      await readJson(res)
    );
  } else {
    results.specialist_appointments_patch_status = {
      skipped: true,
      reason: 'no consultation bookings for this specialist',
    };
  }

  // 10) Patient history
  const patientUserId = firstBooking?.userId;
  if (patientUserId) {
    res = await fetch(
      `${BASE}/api/v1/specialist/patients/${patientUserId}/history`,
      { headers: authHeaders }
    );
    push('specialist_patient_history', res.status, await readJson(res));
  } else {
    results.specialist_patient_history = {
      skipped: true,
      reason: 'no booking with userId to query history',
    };
  }

  // 11) Delete slot (cleanup)
  if (slotId) {
    res = await fetch(`${BASE}/api/v1/specialist/slots/${slotId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    push('specialist_slots_delete', res.status, await readJson(res));
  } else {
    results.specialist_slots_delete = {
      skipped: true,
      reason: 'no slot id from create',
    };
  }

  // 12) Bonus: send OTP via email (record only; verify optional if phone flow worked)
  res = await fetch(`${BASE}/api/v1/auth/specialist/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: SPECIALIST_EMAIL }),
  });
  push('auth_specialist_send_email', res.status, await readJson(res));

  if (seedCleanup) {
    await seedCleanup();
    (out.meta as Record<string, unknown>).seededTempConsultationRemoved = true;
  }

  fs.writeFileSync(
    path.resolve(process.cwd(), 'api-test.json'),
    JSON.stringify(redactForOutput(out), null, 2),
    'utf8'
  );
  console.log('Wrote api-test.json');
}

main().catch((e) => {
  const errOut = {
    meta: { baseUrl: BASE, testedAt: new Date().toISOString() },
    fatal: String(e?.message || e),
    stack: e?.stack,
  };
  fs.writeFileSync(
    path.resolve(process.cwd(), 'api-test.json'),
    JSON.stringify(errOut, null, 2),
    'utf8'
  );
  console.error(e);
  process.exit(1);
});
