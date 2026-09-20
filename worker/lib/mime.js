// Builds an RFC 2822 email for the Gmail API. The body is base64-encoded properly (the previous
// code declared quoted-printable but never encoded, which garbles non-ASCII characters).

const b64 = (buf) => Buffer.from(buf).toString('base64');
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');

export function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
}

export function buildRawEmail({ from, to, cc = [], subject, body, inReplyTo, references }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const message = `${headers.join('\r\n')}\r\n\r\n${wrap76(b64(body))}`;
  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
