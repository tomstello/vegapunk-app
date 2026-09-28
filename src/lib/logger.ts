//About Pino: https://getpino.io/#/
import pino from 'pino';
import pretty from 'pino-pretty';
import { resolveLogLevel } from './logLevel';

// Conditionally import pino-pretty and create a stream only if in development
let prettyStream;

if (process.env.NODE_ENV === 'development') {
    //Create a stream that uses pino-pretty
    prettyStream = pretty({
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        singleLine: false,
        levelFirst: false
    });
}

// LOG_LEVEL (fatal|error|warn|info|debug|trace|silent) overrides the default
// of debug in development and info elsewhere. Read once per instance: on
// Vercel, change the project environment variable and redeploy.
const resolvedLevel = resolveLogLevel(process.env);

export const logger = pino({
    level: resolvedLevel.level,
    base: process.env.NODE_ENV === 'development' ? null : {},
}, prettyStream);

if (resolvedLevel.rejected !== undefined) {
    logger.warn(
        { event: 'log_level_invalid', requested: resolvedLevel.rejected, level: resolvedLevel.level },
        'LOG_LEVEL is not a recognised level; using the default'
    );
}
