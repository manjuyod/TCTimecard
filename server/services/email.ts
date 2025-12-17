import nodemailer, { Transporter } from 'nodemailer';

export interface EmailPayload {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
}

interface EmailMeta {
  feature?: string;
  requestId?: number;
  action?: string;
  error?: string;
}

const truthy = new Set(['1', 'true', 'yes', 'y', 'on']);
const falsy = new Set(['0', 'false', 'no', 'n', 'off']);

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).toLowerCase();
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  return defaultValue;
};

const parseInteger = (value: unknown, defaultValue: number): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return defaultValue;
  return parsed;
};

const EMAIL_SEND_ENABLED = parseBoolean(process.env.EMAIL_SEND_ENABLED, false);
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInteger(process.env.SMTP_PORT, 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || process.env.EMAIL_FROM;

let smtpTransporter: Transporter | null = null;

const getSmtpTransporter = (): Transporter => {
  if (smtpTransporter) return smtpTransporter;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('[email] SMTP_HOST, SMTP_USER, and SMTP_PASS are required when email sending is enabled');
  }

  smtpTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  return smtpTransporter;
};

const normalizeList = (list: string[] | undefined): string[] =>
  (list ?? [])
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

const logEmailPayload = (payload: EmailPayload, meta: EmailMeta = {}) => {
  const envelope = {
    kind: 'email',
    mode: EMAIL_SEND_ENABLED ? 'send' : 'log_only',
    provider: EMAIL_PROVIDER,
    ...meta,
    payload: {
      ...payload,
      to: normalizeList(payload.to),
      cc: normalizeList(payload.cc)
    }
  };

  console.log(JSON.stringify(envelope));
};

export const sendEmail = async (payload: EmailPayload, meta: EmailMeta = {}): Promise<void> => {
  const to = normalizeList(payload.to);
  const cc = normalizeList(payload.cc);

  if (!to.length) {
    logEmailPayload({ ...payload, to, cc }, { ...meta, action: 'skipped_no_recipients' });
    return;
  }

  if (!EMAIL_SEND_ENABLED) {
    logEmailPayload({ ...payload, to, cc }, { ...meta, action: 'log_only' });
    return;
  }

  if (EMAIL_PROVIDER !== 'smtp') {
    logEmailPayload({ ...payload, to, cc }, { ...meta, action: 'unsupported_provider' });
    return;
  }

  const from = SMTP_FROM?.trim();
  if (!from) {
    throw new Error('[email] SMTP_FROM (or EMAIL_FROM) is required when email sending is enabled');
  }

  const transporter = getSmtpTransporter();

  try {
    await transporter.sendMail({
      from,
      to,
      cc: cc.length ? cc : undefined,
      subject: payload.subject,
      text: payload.text
    });

    logEmailPayload({ ...payload, to, cc }, { ...meta, action: 'sent' });
  } catch (err) {
    logEmailPayload({ ...payload, to, cc }, { ...meta, action: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
};
