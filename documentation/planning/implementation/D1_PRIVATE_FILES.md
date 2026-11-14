# D1 — Uploaded files need a login (owner decision 1, 2026-11-14)

Status: design, revised after Codex reviews msg_1794658919870 (references are not authority) and
msg_1794667154658 (unchanged-reference bypass; grant lifecycle). Branch
`m0/d1-private-files` (on `m0/d2-booking-payment-timeout`).

## Goal

Every file under `UPLOAD_DIR` is private by default. A file is readable without login only when it was
deliberately published (public images: doctor photo, pharmacy logo, banners, blog/news images …). A private file is
readable only by readers derived from **trusted facts**: who uploaded it (recorded at upload), which record it was
attached to (recorded at attach time, after checking the attacher may attach it), a server-owned folder, or a curated
legacy manifest. A URL stored in a writable field never grants anything by itself.

## Trusted facts (new collections)

| Collection | Shape | Written by |
|---|---|---|
| `file_uploads` | `{path (unique), uploaderType, uploaderId, createdAt}` | `POST /file/upload[/:module]`, in the same request that writes the bytes (bytes deleted if the row cannot be written) |
| `file_grants` (bindings) | `{path, kind, model, resourceId, field, source: 'attach' \| 'legacy_manifest', createdByType, createdById, createdAt}`, unique `{path, model, resourceId, field}` | attach-time binding by an authorised actor (below); the curated legacy manifest importer |

`kind` ∈ `public`, `booking`, `pharmacy_order`, `specialist`, `pharmacy`, `hr`, `user`.

**A binding is honoured only while it is current**: at read time the record (`model`, `resourceId`) is loaded and its
`field` must still hold the file. Removing or replacing the value, or deleting the record, withdraws it with no detach
code; a binding written late (after a newer removal) or for a save that never committed is inert; several records may
bind the same file and each counts independently (a file stays public while at least one current public binding
exists).

## One read decision, three routes

`GET /api/static/*` (now `authenticateOptional`), `GET /api/v1/file/static/*` and `GET /api/v1/file/fetch?url=`
(both behind `authenticate`; `fetch` also accepts the `/api/static/` form the server actually returns) normalise to one
relative path, then call `FileAccess.decide(reader | null, path)`. The existing `legacyPath` guard (traversal,
symlinks, reserved private subtree) runs first and is unchanged.

Decision, deny by default:

1. A current `public` binding exists → anyone, including anonymous.
2. No reader → 401 (`/api/static` without a token) — no hint whether the file exists.
3. Reader is admin → allow.
4. `file_uploads` row: reader is the uploader → allow.
5. Server-owned folders (exact patterns only, no upload row):
   - `bookings/<24hex>/prescription-<digits>.pdf` → booking readers of that booking;
   - `external-bookings/<24hex>/diagnostics-report-*.pdf` → that booking's customer;
   - `payouts/(invoices|receipts)/…` → admin only (step 3).
6. Any current binding whose resource the reader can read:
   - `booking:<id>` → booking `userId` (user), `specialistId` (specialist), `pharmacyId` (pharmacy), HR with the same
     `corporateId`;
   - `pharmacy_order:<id>` → customer, seller pharmacy, buyer pharmacy (same rule as `getById`);
   - `specialist:<id>` / `pharmacy:<id>` / `hr:<id>` / `user:<id>` → that account.
7. Otherwise 404 (same body as a missing file).

Nothing is cached in-process: every request reads the facts, so a grant change applies on the next request.

Responses: private → `Cache-Control: private, no-store`, `Vary: Authorization`, no `ETag`/`Last-Modified`,
`nosniff`. Public → `public, max-age=3600` (short, so an unpublish is honoured within an hour). `.html` (payout
invoices/receipts) → `Content-Disposition: attachment` + `Content-Security-Policy: sandbox`; never inline.

## Attach-time validation (stops laundering)

`attachFiles(actor, model, specs, save, idOf)` wraps each write: per field, `checkAttachable` runs **before** the save;
after the save the authorised files are bound to that record's field.

- A value that is not one of our upload paths (`/api/static/…`, `/api/v1/file/static/…`, `/api/v1/file/fetch?url=…`,
  an absolute URL whose path is one of those, or a bare `module/file` path) is not a file of ours and passes through
  unchanged (external image URLs keep working).
- Authority = the actor is admin or the recorded uploader. Only authorised files are bound, whether new or unchanged
  (so an authorised re-save repairs a missing binding).
- A file without authority: refused (400 `FILE_NOT_ATTACHABLE`) when new in that field; when the same field already
  held it, kept but **never bound**. A pre-D1 poisoned reference therefore stays inert; only the curated manifest can
  bind legacy files.
- A public field binds images only; a non-image is refused when new.

So a pharmacy cannot set its public `profilePictureUrl` to a customer's prescription, and a customer cannot put
another booking's report into their own booking.

Field → grant kind:

| Fields | Grant |
|---|---|
| `Specialist.profilePictureUrl`, `Pharmacy.profilePictureUrl`, `PharmacyMedicine.imageUrl`, `Corporate.logoUrl`, `Partner.logoUrl`, `Banner.imageUrl`, `Blog.heroImage/sections[].image/seo.ogImage`, `News.image`, `HealthTip.icon/imageUrl`, `WellnessPackage.imageUrl`, `ExternalCatalogItem.image/coverImage`, `User/Admin/HR.profilePictureUrl` | `public` (only images: `.jpg/.jpeg/.png/.webp`; a PDF is refused for a public field) |
| `Booking.documents[].url`, `Booking.prescription.fileUrls[]`, `Booking.report.fileUrls[]` | `booking:<id>` |
| `PharmacyOrder.prescriptionUrls[]` (new values are already 503 today; kept for when that reopens) | `pharmacy_order:<id>` |
| `Specialist.documents[].url` | `specialist:<id>` |
| `Pharmacy.gstCertificateUrl/drugLicenseDocumentUrl/ownerIdProofUrl/shopFrontPhotoUrl` | `pharmacy:<id>` |
| `HR.documents[].url` | `hr:<id>` |

Profile pictures are published (unguessable random names): treating a chosen avatar as public keeps every list that
shows it working without per-viewer rules. Anyone can publish only files they uploaded.

Binding runs after the save and is idempotent (upsert). If it fails the request fails closed: the uploader and admins
can still read the file; any authorised re-save of the record binds again (a unique create that rejects the retry is
repaired by an update). Because reads validate the current record, no transaction with the save is needed.

## Legacy files (no upload row)

`scripts/d1-legacy-file-manifest.ts`:

- `propose` scans the fields above and writes a JSONL proposal: path, proposed grant (from the field), referencing
  records. It **flags** and does not propose: a path referenced by more than one distinct private resource; a path
  referenced by both a public and a private field; a PDF/non-image proposed as public; a path under a server folder.
- An operator reviews the file (the "curated manifest").
- `apply <file>` inserts only unflagged, reviewed entries as `source: 'legacy_manifest'` bindings (record + field, so
  they are validated at read time like any other) and prints counts. Idempotent.

Until the manifest is applied, legacy `general/…` files are readable by admin only. This is the deliberate cost of
the owner's "lock them down": old app screens that open private files by plain URL stop working; public images keep
working once the manifest is applied.

## Also in this packet

- Uploads to the reserved modules `bookings`, `external-bookings`, `payouts` are refused (server folders).
- `/file/fetch` path parsing accepts `/api/static/…` (today it 404s for every URL the server returns).
- External-booking report emails: the absolute unauthenticated link is replaced by "open the app to view your
  report" (the link would now 401).

## Deploy

- Run `sync-indexes` (2 new collections).
- Purge `/api/static/*` and `/api/v1/file/static/*` from any CDN/reverse-proxy cache: the old responses were
  `public, max-age=31536000` and changing origin headers does not recall them.
- Run `propose`, review, `apply` before releasing the new mobile/web builds.

## Not in this packet (recorded follow-ups)

- `GET /bookings/:id` admits any pharmacy/specialist token; `GET /specialists` returns `documents[]` to everyone. With
  D1 their files are no longer readable, but the URLs and metadata still leak.
- The private asset subsystem (`/file/assets`, `/file/clinical`) stays fail-closed (503).

## Tests (planned)

Integration on the local replica set: anonymous/other-user/uploader/admin on each route; public grant anonymous;
server folders; each grant kind's reader set; laundering attempts (pharmacy logo → prescription path, customer booking
→ other booking's report) refused; unchanged values on update accepted; external URLs untouched; headers per class;
html attachment; manifest propose flags + apply idempotent.
