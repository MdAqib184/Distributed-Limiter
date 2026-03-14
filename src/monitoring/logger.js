/**
 * LOGGING — Winston Logger
 * 
 * Structured logging (JSON format) is essential for distributed systems.
 * Each log entry includes timestamp, level, message, and context fields.
 * This makes logs searchable and parseable by tools like Elasticsearch,
 * Datadog, or CloudWatch.
 * 
 * Log Levels (in order of severity):
 * error > warn > info > debug
 */

const winston = require('winston');

const { combine, timestamp, json, colorize, printf } = winston.format;

// Human-readable format for local development
const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? ` ${JSON.stringify(meta)}`
      : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

// Structured JSON format for production (parsed by log aggregators)
const prodFormat = combine(
  timestamp(),
  json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  defaultMeta: {
    service: 'distributed-rate-limiter',
    version: process.env.npm_package_version || '1.0.0',
  },
  transports: [
    new winston.transports.Console(),
    // In production, add file or remote transports:
    // new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    // new winston.transports.Http({ host: 'logs.example.com' }),
  ],
});

module.exports = logger;
