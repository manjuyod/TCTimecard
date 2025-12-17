const GMAIL_COMPOSE_BASE = 'https://mail.google.com/mail/';

export const buildMailtoUrl = (to: string, subject: string, body: string): string => {
  const encodedTo = encodeURIComponent(to || '');
  const encodedSubject = encodeURIComponent(subject);
  const encodedBody = encodeURIComponent(body);
  return `mailto:${encodedTo}?subject=${encodedSubject}&body=${encodedBody}`;
};

export const buildGmailComposeUrl = (to: string, subject: string, body: string): string => {
  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to,
    su: subject,
    body
  });
  return `${GMAIL_COMPOSE_BASE}?${params.toString()}`;
};

