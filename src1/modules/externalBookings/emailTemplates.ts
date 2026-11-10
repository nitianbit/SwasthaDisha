import { CONFIG } from '@/config/config';
import { IExternalBooking } from '@/modules/externalBookings/types';

export type ExternalBookingEmailTemplate =
  | 'CREATED'
  | 'ORDER_SCHEDULED'
  | 'RESCHEDULED'
  | 'PHLEBO_ASSIGNED'
  | 'REPORT_DELIVERED'
  | 'CANCELED';

export interface ExternalBookingEmailContent {
  subject: string;
  textBody: string;
  htmlBody: string;
}

interface BuildExternalBookingEmailInput {
  booking: IExternalBooking;
  template: ExternalBookingEmailTemplate;
  oldBookingDate?: string;
  oldBookingTime?: string;
  userName?: string;
}

const STORE_NAME = CONFIG.STORE_NAME || 'Myewacare';
const SUPPORT_EMAIL = CONFIG.STORE_SUPPORT_EMAIL || 'support@myewacare.com';
const SUPPORT_PHONE = CONFIG.STORE_SUPPORT_PHONE || '+91 9686638384';
const FOOTER_LOGO_URL = CONFIG.STORE_EMAIL_FOOTER_LOGO_URL?.trim();
const BRAND_COLOR = '#6b00ff';
const PAGE_BACKGROUND = '#f1faff';
const CONTENT_BACKGROUND = '#ffffff';
const TEXT_COLOR = '#111827';

export function buildExternalBookingEmailContent({
  booking,
  template,
  oldBookingDate,
  oldBookingTime,
  userName,
}: BuildExternalBookingEmailInput): ExternalBookingEmailContent {
  const meta = asRecord(booking.meta);
  const displayName = (userName || booking.patientName || 'Customer').trim();
  const providerLabel = booking.providerType === 'DIAGNOSTICS' ? 'Lab' : 'Doctor';
  const providerName =
    booking.labName?.trim() ||
    booking.doctorName?.trim() ||
    getFirstString(meta, [
      'labName',
      'lab_name',
      'doctorName',
      'doctor_name',
      'providerName',
    ]) ||
    providerLabel;
  const preparations = getStringArray(meta.preparations);
  const packageNames = normalizeNames(
    booking.packageNames,
    getStringArray(meta.packageNames) || getStringArray(meta.package_name)
  );
  const testNames = normalizeNames(
    booking.testNames,
    getStringArray(meta.testNames) || getStringArray(meta.test_name)
  );
  const centerAddress = isCenterVisit(booking)
    ? getFirstString(meta, ['labAddress', 'lab_address']) ||
      booking.address?.trim() ||
      getFirstString(meta, ['address', 'addressLine', 'locality'])
    : undefined;
  const phleboName =
    getFirstString(meta, [
      'phleboName',
      'phlebotomistName',
      'phleboId',
      'phlebotomistId',
    ]) || 'Assigned executive';
  const phleboContact = getFirstString(meta, [
    'phleboPhone',
    'phlebotomistPhone',
    'phleboMobile',
    'phlebotomistMobile',
    'phleboContact',
  ]);
  const reportUrls = Array.isArray(booking.report)
    ? booking.report
        .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
        .map((url) => toAbsoluteUrl(url))
    : [];

  const view = {
    displayName,
    providerLabel,
    providerName,
    appointmentDate: formatDate(booking.bookingDate),
    appointmentTime: formatTime(booking.bookingTime),
    oldAppointmentDate: oldBookingDate ? formatDate(oldBookingDate) : undefined,
    oldAppointmentTime: oldBookingTime ? formatTime(oldBookingTime) : undefined,
    centerAddress,
    packageNames,
    testNames,
    preparations,
    phleboName,
    phleboContact,
    reportUrls,
  };

  switch (template) {
    case 'CREATED':
      return renderCreated(view);
    case 'ORDER_SCHEDULED':
      return renderConfirmed(view);
    case 'RESCHEDULED':
      return renderRescheduled(view);
    case 'PHLEBO_ASSIGNED':
      return renderPhleboAssigned(view);
    case 'REPORT_DELIVERED':
      return renderReportDelivered(view);
    case 'CANCELED':
    default:
      return renderCanceled(view);
  }
}

function renderCreated(view: any): ExternalBookingEmailContent {
  const subject = 'Your Appointment is pending confirmation';
  const intro =
    `We have received your booking and are working on confirming it with the ${view.providerLabel.toLowerCase()}. ` +
    'You can expect to receive confirmation for your appointment within 24 hours.';
  const detailLead =
    `We are committed to ensuring a seamless and professional experience. Here are the details of your requested appointment with ${view.providerName}:`;
  return renderLifecycle(subject, intro, detailLead, view);
}

function renderConfirmed(view: any): ExternalBookingEmailContent {
  const subject = 'Your Appointment is Confirmed';
  const intro =
    `We are committed to ensuring a seamless and professional experience. Here are the details of your upcoming appointment with ${view.providerName}:`;
  return renderLifecycle(subject, intro, undefined, view);
}

function renderRescheduled(view: any): ExternalBookingEmailContent {
  const subject = 'Your Appointment Has Been Rescheduled';
  const textLines = [
    `Dear ${view.displayName},`,
    '',
    `We are reaching out to confirm that your appointment with ${view.providerName} has been rescheduled. Below are the updated details for your reference:`,
    `Old Appointment Date & Time: ${view.oldAppointmentDate || 'Earlier date'} at ${view.oldAppointmentTime || 'Earlier time'}`,
    `New Appointment Date & Time: ${view.appointmentDate} at ${view.appointmentTime}`,
    ...(view.centerAddress ? [`${view.providerLabel} Address: ${view.centerAddress}`] : []),
    '',
    `Should you have any questions, feel free to contact us at ${SUPPORT_PHONE} or email us at ${SUPPORT_EMAIL}.`,
    'Best regards,',
    STORE_NAME,
  ];

  const htmlBlocks = [
    `<p style="${bodyParagraphStyle()}">Dear ${escapeHtml(view.displayName)},</p>`,
    `<p style="${bodyParagraphStyle()}">We are reaching out to confirm that your appointment with <strong>${escapeHtml(view.providerName)}</strong> has been rescheduled. Below are the updated details for your reference:</p>`,
    `<p style="${bodyParagraphStyle()}"><strong>Old Appointment Date &amp; Time:</strong> ${escapeHtml(view.oldAppointmentDate || 'Earlier date')} at ${escapeHtml(view.oldAppointmentTime || 'Earlier time')}</p>`,
    `<p style="${bodyParagraphStyle()}"><strong>New Appointment Date &amp; Time:</strong> ${escapeHtml(view.appointmentDate)} at ${escapeHtml(view.appointmentTime)}</p>`,
    ...(view.centerAddress
      ? [
          `<p style="${bodyParagraphStyle()}"><strong>${escapeHtml(
            view.providerLabel
          )} Address:</strong> ${escapeHtml(view.centerAddress)}</p>`,
        ]
      : []),
    contactFooterHtml(),
  ];

  return {
    subject,
    textBody: textLines.join('\n'),
    htmlBody: wrapHtml(subject, htmlBlocks),
  };
}

function renderPhleboAssigned(view: any): ExternalBookingEmailContent {
  const subject = 'Your Phlebotomist is Assigned';
  const textLines = [
    `Dear ${view.displayName},`,
    '',
    `We are pleased to inform you that your phlebotomist has been assigned by ${view.providerName}. They will ensure a safe and smooth sample collection experience:`,
    `Phlebotomist Name/Id: ${view.phleboName}`,
    ...(view.phleboContact ? [`Phlebotomist Contact: ${view.phleboContact}`] : []),
    `Appointment Date & Time: ${view.appointmentDate} at ${view.appointmentTime}`,
    '',
    `Should you have any questions, feel free to contact us at ${SUPPORT_PHONE} or email us at ${SUPPORT_EMAIL}.`,
    'Best regards,',
    STORE_NAME,
  ];

  const htmlBlocks = [
    `<p style="${bodyParagraphStyle()}">Dear ${escapeHtml(view.displayName)},</p>`,
    `<p style="${bodyParagraphStyle()}">We are pleased to inform you that your phlebotomist has been assigned by <strong>${escapeHtml(view.providerName)}</strong>. They will ensure a safe and smooth sample collection experience:</p>`,
    `<p style="${bodyParagraphStyle()}"><strong>Phlebotomist Name/Id:</strong> ${escapeHtml(view.phleboName)}<br/>` +
      `${view.phleboContact ? `<strong>Phlebotomist Contact:</strong> ${escapeHtml(view.phleboContact)}<br/>` : ''}` +
      `<strong>Appointment Date &amp; Time:</strong> ${escapeHtml(view.appointmentDate)} at ${escapeHtml(view.appointmentTime)}</p>`,
    contactFooterHtml(),
  ];

  return {
    subject,
    textBody: textLines.join('\n'),
    htmlBody: wrapHtml(subject, htmlBlocks),
  };
}

function renderReportDelivered(view: any): ExternalBookingEmailContent {
  const subject = 'Your Test Results are Ready';
  const textLines = [
    `Dear ${view.displayName},`,
    '',
    `We are pleased to inform you that your lab test results from ${view.providerName} are now ready.`,
    ...(view.reportUrls.length
      ? ['Please use the link(s) below to access your report(s):', ...view.reportUrls]
      : ['Your report(s) can now be accessed from your booking.']),
    '',
    `Should you have any questions, feel free to contact us at ${SUPPORT_PHONE} or email us at ${SUPPORT_EMAIL}.`,
    'Best regards,',
    STORE_NAME,
  ];

  const htmlBlocks = [
    `<p style="${bodyParagraphStyle()}">Dear ${escapeHtml(view.displayName)},</p>`,
    `<p style="${bodyParagraphStyle()}">We are pleased to inform you that your lab test results from <strong>${escapeHtml(view.providerName)}</strong> are now ready.</p>`,
    ...(view.reportUrls.length
      ? [
          `<p style="${bodyParagraphStyle()}">Please use the link(s) below to access your report(s):</p>`,
          `<ul style="padding-left:20px;color:${TEXT_COLOR};font-size:14px;line-height:1.7;">${view.reportUrls
            .map(
              (url: string) =>
                `<li><a href="${escapeHtml(url)}" style="color:${BRAND_COLOR};word-break:break-all;">${escapeHtml(
                  url
                )}</a></li>`
            )
            .join('')}</ul>`,
        ]
      : [
          `<p style="${bodyParagraphStyle()}">Your report(s) can now be accessed from your booking.</p>`,
        ]),
    contactFooterHtml(),
  ];

  return {
    subject,
    textBody: textLines.join('\n'),
    htmlBody: wrapHtml(subject, htmlBlocks),
  };
}

function toAbsoluteUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const baseUrl = (CONFIG.REPORT_URL || CONFIG.BASE_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (!baseUrl) {
    return trimmed;
  }

  return `${baseUrl}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`;
}

function renderCanceled(view: any): ExternalBookingEmailContent {
  const subject = 'Your Appointment has been Cancelled';
  const textLines = [
    `Dear ${view.displayName},`,
    '',
    `We regret to inform you that your appointment with ${view.providerName} has been cancelled.`,
    `Cancelled Appointment Date & Time: ${view.appointmentDate} at ${view.appointmentTime}`,
    '',
    'We value your trust and hope to serve you again soon.',
    `Should you have any questions, feel free to contact us at ${SUPPORT_PHONE} or email us at ${SUPPORT_EMAIL}.`,
    'Best regards,',
    STORE_NAME,
  ];

  const htmlBlocks = [
    `<p style="${bodyParagraphStyle()}">Dear ${escapeHtml(view.displayName)},</p>`,
    `<p style="${bodyParagraphStyle()}">We regret to inform you that your appointment with <strong>${escapeHtml(view.providerName)}</strong> has been cancelled.</p>`,
    `<p style="${bodyParagraphStyle()}"><strong>Cancelled Appointment Date &amp; Time:</strong> ${escapeHtml(view.appointmentDate)} at ${escapeHtml(view.appointmentTime)}</p>`,
    `<p style="${bodyParagraphStyle()}">We value your trust and hope to serve you again soon.</p>`,
    contactFooterHtml(),
  ];

  return {
    subject,
    textBody: textLines.join('\n'),
    htmlBody: wrapHtml(subject, htmlBlocks),
  };
}

function renderLifecycle(
  subject: string,
  intro: string,
  detailLead: string | undefined,
  view: any
): ExternalBookingEmailContent {
  const textLines = [
    `Dear ${view.displayName},`,
    '',
    intro,
    ...(detailLead ? [detailLead] : []),
    `Appointment Date & Time: ${view.appointmentDate} at ${view.appointmentTime}`,
    ...(view.centerAddress ? [`${view.providerLabel} Address: ${view.centerAddress}`] : []),
    ...(view.packageNames.length
      ? [`Package(s): ${view.packageNames.join(', ')}`]
      : []),
    ...(view.testNames.length ? [`Test(s): ${view.testNames.join(', ')}`] : []),
    ...(view.preparations.length
      ? [
          'To prepare for your appointment, make sure you do the following:',
          ...view.preparations.map((item: string) => `- ${item}`),
        ]
      : []),
    '',
    `Should you have any questions, feel free to contact us at ${SUPPORT_PHONE} or email us at ${SUPPORT_EMAIL}.`,
    'Best regards,',
    STORE_NAME,
  ];

  const htmlBlocks = [
    `<p style="${bodyParagraphStyle()}">Dear ${escapeHtml(view.displayName)},</p>`,
    `<p style="${bodyParagraphStyle()}">${escapeHtml(intro)}</p>`,
    ...(detailLead
      ? [`<p style="${bodyParagraphStyle()}">${escapeHtml(detailLead)}</p>`]
      : []),
    `<p style="${bodyParagraphStyle()}"><strong>Appointment Date &amp; Time:</strong> ${escapeHtml(view.appointmentDate)} at ${escapeHtml(view.appointmentTime)}</p>`,
    ...(view.centerAddress
      ? [
          `<p style="${bodyParagraphStyle()}"><strong>${escapeHtml(
            view.providerLabel
          )} Address:</strong> ${escapeHtml(view.centerAddress)}</p>`,
        ]
      : []),
    ...(view.packageNames.length
      ? [
          `<p style="${bodyParagraphStyle()}"><strong>Package(s):</strong> ${escapeHtml(
            view.packageNames.join(', ')
          )}</p>`,
        ]
      : []),
    ...(view.testNames.length
      ? [
          `<p style="${bodyParagraphStyle()}"><strong>Test(s):</strong> ${escapeHtml(
            view.testNames.join(', ')
          )}</p>`,
        ]
      : []),
    ...(view.preparations.length
      ? [
          `<p style="${bodyParagraphStyle()}"><strong>To prepare for your appointment, make sure you do the following:</strong></p>`,
          `<ul style="${listStyle()}">${view.preparations
            .map((item: string) => `<li style="${listItemStyle()}">${escapeHtml(item)}</li>`)
            .join('')}</ul>`,
        ]
      : []),
    contactFooterHtml(),
  ];

  return {
    subject,
    textBody: textLines.join('\n'),
    htmlBody: wrapHtml(subject, htmlBlocks),
  };
}

function contactFooterHtml(): string {
  return (
    `<p style="${bodyParagraphStyle()}">Should you have any questions, feel free to contact us at ${escapeHtml(
      SUPPORT_PHONE
    )} or email us at <a href="mailto:${escapeHtml(
      SUPPORT_EMAIL
    )}" style="color:${BRAND_COLOR};text-decoration:none;">${escapeHtml(
      SUPPORT_EMAIL
    )}</a>.</p>` +
    `<p style="${bodyParagraphStyle()}">Best regards,<br/>${escapeHtml(
      STORE_NAME
    )}</p>`
  );
}

function isCenterVisit(booking: IExternalBooking): boolean {
  const appointmentType = (booking.appointmentType || '').trim().toUpperCase();
  return appointmentType === 'CENTER_VISIT' || appointmentType === 'IN_PERSON';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getFirstString(
  source: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }

  return undefined;
}

function getStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : String(item || '').trim()))
      .filter(Boolean);
  }

  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeNames(
  primary?: string[],
  fallback?: string[]
): string[] {
  const source = primary?.length ? primary : fallback;
  return (source || []).map((item) => item.trim()).filter(Boolean);
}

function formatDate(value?: string): string {
  if (!value) {
    return 'Scheduled date';
  }
  const yyyymmdd = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (!yyyymmdd) {
    return value;
  }
  const date = new Date(
    Date.UTC(Number(yyyymmdd[1]), Number(yyyymmdd[2]) - 1, Number(yyyymmdd[3]))
  );
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatTime(value?: string): string {
  if (!value) {
    return 'Scheduled time';
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '');
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?(am|pm)?$/.exec(normalized);
  if (!match) {
    return value;
  }
  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = match[3];

  if (suffix === 'pm' && hour !== 12) {
    hour += 12;
  } else if (suffix === 'am' && hour === 12) {
    hour = 0;
  }

  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${period}`;
}

function wrapHtml(title: string, blocks: string[]): string {
  return (
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="UTF-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
    `<title>${escapeHtml(title)}</title>` +
    '</head>' +
    `<body style="margin:0;padding:0;background:${PAGE_BACKGROUND};font-family:Arial,sans-serif;color:${TEXT_COLOR};">` +
    `<div style="background:${PAGE_BACKGROUND};padding:32px 16px;width:100%;">` +
    '<div style="max-width:600px;width:100%;margin:0 auto;">' +
    `<div style="background:${BRAND_COLOR};padding:20px 24px;">` +
    `<p style="margin:0;font-size:28px;line-height:1.3;font-weight:700;color:#ffffff;">${escapeHtml(
      title
    )}</p>` +
    '</div>' +
    `<div style="background:${CONTENT_BACKGROUND};padding:24px;min-height:320px;">${blocks.join(
      ''
    )}</div>` +
    `<div style="background:${BRAND_COLOR};padding:16px 24px;min-height:60px;">${renderFooterBrand()}</div>` +
    '</div>' +
    '</div>' +
    '</body>' +
    '</html>'
  );
}

function renderFooterBrand(): string {
  if (FOOTER_LOGO_URL) {
    return `<img src="${escapeHtml(
      FOOTER_LOGO_URL
    )}" alt="${escapeHtml(
      STORE_NAME
    )}" style="display:block;max-width:200px;max-height:60px;width:auto;height:auto;object-fit:contain;" />`;
  }

  return `<p style="margin:0;font-size:22px;line-height:1.4;font-weight:700;color:#ffffff;">${escapeHtml(
    STORE_NAME
  )}</p>`;
}

function bodyParagraphStyle(): string {
  return `margin:0 0 16px;font-size:16px;line-height:1.7;color:${TEXT_COLOR};`;
}

function listStyle(): string {
  return 'margin:0 0 16px;padding-left:20px;color:#111827;';
}

function listItemStyle(): string {
  return `margin:0 0 8px;font-size:16px;line-height:1.7;color:${TEXT_COLOR};`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
