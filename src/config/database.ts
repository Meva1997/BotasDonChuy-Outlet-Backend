import { Sequelize } from "sequelize";
import dotenv from "dotenv";
import { logger } from "./logger";
import { databaseSslOptions } from "./databaseSsl";

dotenv.config({ quiet: true });

const DATABASE_URL = process.env.DATABASE_URL!;

export const sequelize = new Sequelize(DATABASE_URL, {
  dialect: "postgres",
  logging: process.env.NODE_ENV === "development" ? (sql) => logger.debug(sql) : false,
  // TLS explícito: un `?sslmode=…` en la cadena NO llega a `pg` (ver `databaseSsl.ts`).
  // Sin `DATABASE_SSL` esto es `{}` y la conexión queda exactamente como antes.
  dialectOptions: databaseSslOptions(),
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
});

export const connectDB = async (): Promise<void> => {
  try {
    await sequelize.authenticate();
    logger.info("PostgreSQL connection established");
  } catch (error) {
    // Sin Sentry aquí: el proceso sale (process.exit) enseguida, sin tiempo útil de
    // transporte — ya es lo bastante ruidoso (el deploy falla).
    logger.error({ err: error }, "Error connecting to the database");
    process.exit(1);
  }
};
