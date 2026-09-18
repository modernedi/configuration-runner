export class ConfigurationRunnerError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = "ConfigurationRunnerError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function runnerError(
  code: string,
  message: string,
  exitCode = 1,
): ConfigurationRunnerError {
  return new ConfigurationRunnerError(code, message, exitCode);
}
