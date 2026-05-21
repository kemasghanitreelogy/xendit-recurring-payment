import { env } from './env';

// Lightweight structured logger.
// - All output is single-line JSON so Vercel log drains / Logtail / Datadog
//   can ingest without a parser.
// - `alert()` additionally POSTs to ALERT_WEBHOOK_URL if set (Slack/Discord
//   incoming webhook URL works as-is).

type Level = 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;

function emit(level: Level, msg: string, fields?: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  // Use stdout for info, stderr for warn/error so log levels survive.
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info(msg: string, fields?: LogFields) {
    emit('info', msg, fields);
  },
  warn(msg: string, fields?: LogFields) {
    emit('warn', msg, fields);
  },
  error(msg: string, fields?: LogFields) {
    emit('error', msg, fields);
  },
};

/**
 * Emit an error log AND best-effort POST to the configured alert webhook.
 * Never throws — alerting failures must not break the request that called us.
 */
export async function alert(msg: string, fields?: LogFields): Promise<void> {
  emit('error', msg, fields);
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    // Slack/Discord both accept `{text: "..."}`. We include a JSON code block
    // for the fields so the alert is actually readable in chat.
    const text =
      `🚨 *${msg}*\n` +
      (fields ? '```' + JSON.stringify(fields, null, 2).slice(0, 1800) + '```' : '');
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    emit('warn', 'alert webhook failed', { error: String(err).slice(0, 200) });
  }
}
