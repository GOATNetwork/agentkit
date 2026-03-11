export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeLogger {
  log: (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;
}

export const consoleLogger: RuntimeLogger = {
  log(level, message, meta) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
    // structured log
    console.log(JSON.stringify(payload));
  },
};
