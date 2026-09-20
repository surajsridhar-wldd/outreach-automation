// A rehearsal also proves the two things that cannot be checked by reading drafts:
//   1. threading: a follow-up sent with the first message's thread id and Message-ID must land in the
//      SAME Gmail conversation (the old system started a new thread every time, hiding replies)
//   2. the Slack path: a DM to the owner themselves
// Both go only to the owner.

export async function threadingSelfTest({ senders, to, runId }) {
  const subject = `[REHEARSAL SELF-TEST] Threading check ${runId.slice(0, 8)}`;
  const first = await senders.email({
    idempotencyKey: `selftest-${runId}-1`, to, cc: [], subject,
    body: 'Threading self-test, message 1 of 2. Nothing to do; this only checks the system.',
  });
  const second = await senders.email({
    idempotencyKey: `selftest-${runId}-2`, to, cc: [], subject: `Re: ${subject}`,
    body: 'Threading self-test, message 2 of 2. This should appear in the SAME conversation as message 1.',
    threadId: first.threadId, inReplyTo: first.rfcMessageId, references: first.rfcMessageId,
  });
  return {
    threaded: !!first.rfcMessageId && first.threadId === second.threadId,
    firstThread: first.threadId, secondThread: second.threadId, hadMessageId: !!first.rfcMessageId,
  };
}

export async function slackSelfTest({ senders, ownerEmail, runId }) {
  const r = await senders.slack({ person: { email: ownerEmail }, text: '[REHEARSAL SELF-TEST] Slack path check. Nothing to do.', idempotencyKey: `selftest-${runId}-slack` });
  return { ok: !!r.ok, error: r.error || null };
}
