export type LogLevel = "debug" | "error" | "info" | "warn";
export type RuntimeEnvironment = "development" | "production" | "test";

export interface RuntimeConfig {
  readonly databaseUrl: string;
  readonly environment: RuntimeEnvironment;
  readonly logLevel: LogLevel;
  readonly redisUrl: string;
}

export class ConfigurationError extends Error {
  public constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration: ${issues.join("; ")}`);
    this.name = "ConfigurationError";
  }
}

export function parseRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeConfig {
  const issues: string[] = [];
  const runtimeEnvironment = parseChoice(
    environment.NODE_ENV,
    "NODE_ENV",
    ["development", "production", "test"] as const,
    issues,
  );
  const logLevel = parseChoice(
    environment.LOG_LEVEL,
    "LOG_LEVEL",
    ["debug", "error", "info", "warn"] as const,
    issues,
  );
  const databaseUrl = parseUrl(
    environment.DATABASE_URL,
    "DATABASE_URL",
    ["postgres:", "postgresql:"],
    issues,
  );
  const redisUrl = parseUrl(
    environment.REDIS_URL,
    "REDIS_URL",
    ["redis:", "rediss:"],
    issues,
  );

  if (
    issues.length > 0 ||
    runtimeEnvironment === undefined ||
    logLevel === undefined ||
    databaseUrl === undefined ||
    redisUrl === undefined
  ) {
    throw new ConfigurationError(issues);
  }

  return { databaseUrl, environment: runtimeEnvironment, logLevel, redisUrl };
}

function parseChoice<const Choice extends string>(
  value: string | undefined,
  name: string,
  choices: readonly Choice[],
  issues: string[],
): Choice | undefined {
  if (value === undefined || !choices.includes(value as Choice)) {
    issues.push(`${name} must be one of: ${choices.join(", ")}`);
    return undefined;
  }
  return value as Choice;
}

function parseUrl(
  value: string | undefined,
  name: string,
  protocols: readonly string[],
  issues: string[],
): string | undefined {
  if (value === undefined) {
    issues.push(`${name} is required`);
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) {
      issues.push(`${name} must use ${protocols.join(" or ")}`);
      return undefined;
    }
  } catch {
    issues.push(`${name} must be a valid URL`);
    return undefined;
  }
  return value;
}
