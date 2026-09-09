export type LogLevel = "debug" | "error" | "info" | "warn";
export type LogValue =
  | boolean
  | null
  | number
  | string
  | readonly LogValue[]
  | LogFields;

export interface LogFields {
  readonly [key: string]: LogValue;
}

export interface LogContext {
  readonly correlationId: string;
  readonly jobId?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
}

export interface LogClock {
  now(): Date;
}

export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

const levels: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const sensitiveKeys = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "completion",
  "credential",
  "password",
  "prompt",
  "rawproviderresponse",
  "refreshtoken",
  "secret",
  "systemprompt",
  "token",
]);

export function createJsonLogger(options: {
  readonly clock: LogClock;
  readonly context: LogContext;
  readonly minimumLevel: LogLevel;
  readonly sink: LogSink;
}): Logger {
  const write = (
    level: LogLevel,
    event: string,
    fields: LogFields = {},
  ): void => {
    if (levels[level] < levels[options.minimumLevel]) return;
    const record = {
      timestamp: options.clock.now().toISOString(),
      level,
      event,
      ...options.context,
      fields: redact(fields),
    };
    options.sink.write(JSON.stringify(record));
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    error: (event, fields) => write("error", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
  };
}

function redact(value: LogValue): LogValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        isSensitive(key) ? "[REDACTED]" : redact(nested),
      ]),
    );
  }
  return value;
}

function isSensitive(key: string): boolean {
  return sensitiveKeys.has(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ""));
}
