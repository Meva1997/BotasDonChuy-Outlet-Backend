import pino from "pino";

// Todos los flujos que loguean hoy (webhooks, el sweeper, envíos fire-and-forget) son
// procesos de fondo sin request en vuelo, no rutas HTTP — por eso no hay un child logger
// por request (no se usa pino-http). El nombre de campo `err` es intencional: el
// serializador por defecto de pino expande `err.stack` automáticamente solo bajo esa key.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
});
