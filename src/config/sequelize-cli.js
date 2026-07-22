// sequelize-cli never imports app.ts, so unlike the runtime app it needs its
// own dotenv bootstrap here (same reasoning as stripe.ts/cloudinary.ts's own
// dotenv.config() at module top).
require("dotenv").config();

const shared = {
  use_env_variable: "DATABASE_URL",
  dialect: "postgres",
  logging: false,
};

module.exports = {
  development: { ...shared },
  test: { ...shared },
  production: { ...shared },
};
