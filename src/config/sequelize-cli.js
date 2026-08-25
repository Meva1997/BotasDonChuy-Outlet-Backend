// sequelize-cli never imports app.ts, so unlike the runtime app it needs its
// own dotenv bootstrap here (same reasoning as stripe.ts/cloudinary.ts's own
// dotenv.config() at module top).
require("dotenv").config({ quiet: true });

// Este archivo es .js plano (tsc no lo compila a dist/, y el CLI no lo necesita ahí), pero sí
// puede requerir un .ts: `.sequelizerc` registra ts-node antes de cargar esta config. Se hace a
// propósito para NO duplicar la lógica de TLS — el CLI abre su propia conexión a la misma base
// que la app, y una copia a mano acabaría divergiendo justo en lo que no debe (ver databaseSsl.ts).
const { databaseSslOptions } = require("./databaseSsl");

const shared = {
  use_env_variable: "DATABASE_URL",
  dialect: "postgres",
  logging: false,
  dialectOptions: databaseSslOptions(),
};

module.exports = {
  development: { ...shared },
  test: { ...shared },
  production: { ...shared },
};
