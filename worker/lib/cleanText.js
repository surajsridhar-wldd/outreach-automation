// Turns a raw email/Slack reply into just what the person wrote: quoted history, signatures and
// forwarded blocks are removed, so the model reads (and is billed for) new text only.

const QUOTE_START = [
  /^On .{0,200}wrote:\s*$/i,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^From:\s.+/i,               // start of an inlined header block
  /^_{5,}\s*$/,
  /^Sent from my /i,
  /^Get Outlook for /i,
];

export function cleanReply(raw, { maxChars = 1500 } = {}) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // "On Mon, 21 Sep 2026 at 11:02, X <x@y> wrote:" is often wrapped over two lines.
    const joined = `${line} ${lines[i + 1] || ''}`.trim();
    if (QUOTE_START.some((re) => re.test(line.trim()) || (/^On /i.test(line.trim()) && re.test(joined)))) break;
    if (/^>/.test(line.trim())) continue;
    if (/^--\s*$/.test(line)) break;                    // signature delimiter
    kept.push(line);
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Out-of-office, delivery notices and other machine mail must never be read as a person's answer. */
export function isAutoReply({ from = '', subject = '', autoSubmitted = '', text = '' }) {
  if (autoSubmitted && !/^no$/i.test(autoSubmitted.trim())) return true;
  if (/mailer-daemon|postmaster|no-?reply/i.test(from)) return true;
  if (/^(automatic reply|auto(-|\s)?reply|out of office|undeliverable|delivery status notification)/i.test(subject.trim())) return true;
  return /^(i am|i'm) (currently )?(out of (the )?office|on leave)/i.test(String(text).trim());
}

/** "Priya Sharma <priya@wldd.in>" -> "priya@wldd.in" */
export function addressOf(header = '') {
  const m = String(header).match(/<([^>]+)>/);
  return (m ? m[1] : String(header)).trim().toLowerCase();
}
