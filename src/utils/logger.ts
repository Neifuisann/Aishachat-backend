export enum LogLevel {
    DEBUG = 10,
    INFO = 20,
    WARN = 30,
    ERROR = 40,
}

let currentLevel: LogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel) {
    currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
    return level >= currentLevel;
}

function format(level: LogLevel, prefix: string, message: string): string {
    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level];
    return `[${timestamp}] [${levelStr}] ${prefix}${message}`;
}

export class Logger {
    constructor(private prefix = '') {}

    private output(level: LogLevel, message: string, args: any[]) {
        if (!shouldLog(level)) return;
        const formatted = format(level, this.prefix, message);
        if (level >= LogLevel.ERROR) {
            console.error(formatted, ...args);
        } else if (level >= LogLevel.WARN) {
            console.warn(formatted, ...args);
        } else {
            console.log(formatted, ...args);
        }
    }

    debug(message: string, ...args: any[]) {
        this.output(LogLevel.DEBUG, message, args);
    }

    info(message: string, ...args: any[]) {
        this.output(LogLevel.INFO, message, args);
    }

    warn(message: string, ...args: any[]) {
        this.output(LogLevel.WARN, message, args);
    }

    error(message: string, ...args: any[]) {
        this.output(LogLevel.ERROR, message, args);
    }
}

export function createLogger(prefix: string) {
    return new Logger(prefix);
}
