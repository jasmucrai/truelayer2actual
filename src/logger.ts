type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const threshold =
  raw in LEVEL_ORDER ? LEVEL_ORDER[raw as Level] : LEVEL_ORDER.info;

function formatMessage(level: string, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const message = args
    .map((arg) =>
      typeof arg === 'object' && arg !== null
        ? JSON.stringify(arg)
        : String(arg)
    )
    .join(' ');
  return `${timestamp} [${level}] ${message}`;
}

function enabled(level: Level): boolean {
  return LEVEL_ORDER[level] >= threshold;
}

export const logger = {
  debug(...args: unknown[]): void {
    if (enabled('debug')) process.stdout.write(formatMessage('DEBUG', args) + '\n');
  },

  info(...args: unknown[]): void {
    if (enabled('info')) process.stdout.write(formatMessage('INFO', args) + '\n');
  },

  warn(...args: unknown[]): void {
    if (enabled('warn')) process.stderr.write(formatMessage('WARN', args) + '\n');
  },

  error(...args: unknown[]): void {
    if (enabled('error')) process.stderr.write(formatMessage('ERROR', args) + '\n');
  },
};
