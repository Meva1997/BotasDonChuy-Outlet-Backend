import "./config/sentry"; // arma Sentry antes que cualquier otro módulo pueda lanzar al arrancar
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
import { connectDB, sequelize } from "./config/database";
import { logger } from "./config/logger";
import "./config/cloudinary"; // valida las llaves de Cloudinary al arrancar (fail-fast)
import "./config/resend"; // valida RESEND_API_KEY + EMAIL_FROM al arrancar (fail-fast)
import "./config/skydropx"; // valida SKYDROPX_CLIENT_ID + SKYDROPX_CLIENT_SECRET al arrancar (fail-fast)
import "./config/zod"; // mensajes por defecto de zod en español (los pinta el front)
import { swaggerSpec } from "./config/swagger";
import productRoutes from "./routes/product.routes";
import authRoutes from "./routes/auth.routes";
import adminProductRoutes from "./routes/adminProduct.routes";
import orderRoutes from "./routes/order.routes";
import webhookRoutes from "./routes/webhook.routes";
import adminDashboardRoutes from "./routes/adminDashboard.routes";
import adminOrderRoutes from "./routes/adminOrder.routes";
import adminReportsRoutes from "./routes/adminReports.routes";
import brandRoutes from "./routes/brand.routes";
import adminUserRoutes from "./routes/adminUser.routes";
import accountRoutes from "./routes/account.routes";
import shippingRoutes from "./routes/shipping.routes";
import { errorHandler } from "./middlewares/errorHandler";
import {
  startPendingOrderSweeper,
  stopPendingOrderSweeper,
} from "./services/pendingOrderSweeper";
import "./models/Product"; // register the model so sync() creates its table
import "./models/ProductSize";
import "./models/AdminUser";
import "./models/Order";
import "./models/OrderItem";
import "./models/BrandSettings";
import "./models/associations";

dotenv.config({ quiet: true });

const app: Express = express();
const PORT = process.env.PORT || 4000;

// El arranque real (conexión a la BD, sweeper, servidor HTTP y apagado ordenado) vive
// al final del archivo, gateado por `NODE_ENV !== "test"`: Supertest importa este `app`
// directamente y no debe abrir un puerto, conectar a la BD ni correr el cron — los tests
// gestionan la conexión y la limpieza de la BD por su cuenta (ver tests/setup/db.ts).

//Global Middleware
app.use(helmet());
const corsOrigins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim());
app.use(cors({ origin: corsOrigins }));

// Webhook de Stripe: la verificación de firma exige el cuerpo CRUDO, así que se
// monta con express.raw ANTES del express.json() global (que solo parsea el resto).
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhookRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API docs (Swagger UI + raw OpenAPI JSON)
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/api/docs.json", (req, res) => {
  res.json(swaggerSpec);
});

//routes
app.use("/api/products", productRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin/products", adminProductRoutes);
app.use("/api/admin/dashboard", adminDashboardRoutes);
app.use("/api/admin/orders", adminOrderRoutes);
app.use("/api/admin/reports", adminReportsRoutes);
app.use("/api/admin/brand", brandRoutes); // GET pública, PUT protegido dentro del router
app.use("/api/admin/users", adminUserRoutes);
app.use("/api/admin/account", accountRoutes);
app.use("/api/orders", orderRoutes); // checkout público
app.use("/api/shipping", shippingRoutes); // cotización en vivo, pública
// (El webhook de Stripe se monta arriba, antes de express.json(), para verificar
// la firma sobre el cuerpo crudo.)

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Healthcheck del servicio
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: El servicio está operativo.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
// Verification route
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use(errorHandler);

// Arranque real del servidor. Se omite por completo en entorno de test
// (`NODE_ENV === "test"`): Supertest importa el `app` de arriba sin abrir un puerto,
// conectar a la BD ni arrancar el sweeper. Todo lo que tiene efectos de proceso
// (listen, señales de apagado, pool de la BD) queda encapsulado aquí dentro.
if (process.env.NODE_ENV !== "test") {
  connectDB();
  startPendingOrderSweeper(); // libera stock de órdenes pending abandonadas (Stripe)

  const server = app.listen(PORT, () => {
    logger.info(`Server running at http://localhost:${PORT}`);
  });

  /**
   * Apagado ordenado (Fase H.5). Un redeploy envía `SIGTERM` (o `SIGINT` con Ctrl+C
   * en dev): en vez de morir de golpe a media transacción, se cierra en orden —
   *   1. detener el sweeper (deja de abrir trabajo nuevo),
   *   2. `server.close()` deja de aceptar conexiones y espera las requests en vuelo,
   *   3. cerrar el pool de Sequelize.
   * Un guard de timeout fuerza la salida si algo cuelga, para no dejar el proceso zombie.
   */
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return; // ignora señales repetidas
    isShuttingDown = true;
    logger.info({ signal }, "Apagado ordenado iniciado");

    // Red de seguridad: si el cierre se atora (una conexión colgada que impide que
    // `server.close()` resuelva), salir con código de error tras 10s. `unref()` para
    // que este timer no mantenga vivo el proceso por sí solo si todo cierra antes.
    const forceExit = setTimeout(() => {
      logger.error("Apagado ordenado excedió el tiempo límite; forzando salida");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      stopPendingOrderSweeper();
      logger.info("Sweeper de pendientes detenido");

      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      logger.info("Servidor HTTP cerrado (sin conexiones nuevas)");

      await sequelize.close();
      logger.info("Pool de la base de datos cerrado");

      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error durante el apagado ordenado");
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
}

export default app;
