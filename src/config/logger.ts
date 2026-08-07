import pino from "pino";

// Todos los flujos que loguean hoy (webhooks, el sweeper, envíos fire-and-forget) son
// procesos de fondo sin request en vuelo, no rutas HTTP — por eso no hay un child logger
// por request (no se usa pino-http). El nombre de campo `err` es intencional: el
// serializador por defecto de pino expande `err.stack` automáticamente solo bajo esa key.
// Bajo `NODE_ENV=test` el logger se construye sin transporte y contra un destino SÍNCRONO,
// y ninguna de las dos cosas es cosmética. Jest aísla el registro de módulos por archivo de
// test pero comparte el objeto `process` real, así que con `maxWorkers: 1` los 57 archivos
// construyen 57 loggers sobre el mismo proceso, y cada uno dejaba residuo:
//   - el transporte de pino-pretty levanta un worker de `thread-stream` que nunca se
//     termina (la suite acababa con ~20 hilos fugados) y registra listeners `exit` +
//     `beforeExit` vía `on-exit-leak-free` (pino/lib/transport.js);
//   - el destino por defecto (`SonicBoom` asíncrono) registra otro listener `exit`
//     (`buildSafeSonicBoom` en pino/lib/tools.js, que solo lo omite si `sync: true`).
// De ahí el `MaxListenersExceededWarning` al 11.º listener. En dev/prod cada proceso
// construye el logger UNA vez, así que ahí no hay nada que arreglar.
const isTest = process.env.NODE_ENV === "test";

function defaultLevel(): string {
  if (isTest) return "silent";
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const options = {
  level: process.env.LOG_LEVEL ?? defaultLevel(),
  transport:
    process.env.NODE_ENV === "production" || isTest
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
};

export const logger = isTest
  ? pino(options, pino.destination({ dest: 1, sync: true }))
  : pino(options);
