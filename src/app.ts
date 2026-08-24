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
import productRoutes from "./routes/public/product.routes";
import authRoutes from "./routes/auth/auth.routes";
import adminProductRoutes from "./routes/admin/adminProduct.routes";
import orderRoutes from "./routes/public/order.routes";
import webhookRoutes from "./routes/webhooks/webhook.routes";
import adminDashboardRoutes from "./routes/admin/adminDashboard.routes";
import adminOrderRoutes from "./routes/admin/adminOrder.routes";
import adminReportsRoutes from "./routes/admin/adminReports.routes";
import brandRoutes from "./routes/admin/brand.routes";
import adminUserRoutes from "./routes/admin/adminUser.routes";
import accountRoutes from "./routes/admin/account.routes";
import shippingRoutes from "./routes/public/shipping.routes";
import couponRoutes from "./routes/public/coupon.routes";
import adminCouponRoutes from "./routes/admin/adminCoupon.routes";
import adminExpenseRoutes from "./routes/admin/adminExpense.routes";
import { errorHandler } from "./middlewares/errorHandler";
import { apiDocsEnabled, trustProxyEnv } from "./utils/env";
import { checkReadiness, markDraining } from "./services/readiness";
import {
  startPendingOrderSweeper,
  stopPendingOrderSweeper,
} from "./services/pendingOrderSweeper";
import {
  startShipmentRetrySweeper,
  stopShipmentRetrySweeper,
} from "./services/shipmentRetrySweeper";
import {
  startDailySalesDigest,
  stopDailySalesDigest,
} from "./services/dailySalesDigest";
import "./models/Product"; // register the model so sync() creates its table
import "./models/ProductSize";
import "./models/AdminUser";
import "./models/Order";
import "./models/OrderItem";
import "./models/BrandSettings";
import "./models/Coupon";
import "./models/CouponRedemption";
import "./models/Expense";
import "./models/ExpenseAmount";
import "./models/associations";

dotenv.config({ quiet: true });

const app: Express = express();
const PORT = process.env.PORT || 4000;

// Detrás de un proxy, `req.ip` es la IP del proxy salvo que Express sepa en cuántos saltos
// confiar — y de `req.ip` cuelgan TODOS los rate limiters (ver utils/env.ts para por qué esto
// no se activa solo). Se aplica antes de montar cualquier ruta.
const trustProxy = trustProxyEnv();
if (trustProxy !== undefined) {
  app.set("trust proxy", trustProxy);
  logger.info({ trustProxy }, "trust proxy configurado (req.ip viene de X-Forwarded-For)");
}

// El arranque real (conexión a la BD, sweeper, servidor HTTP y apagado ordenado) vive
// al final del archivo, gateado por `NODE_ENV !== "test"`: Supertest importa este `app`
// directamente y no debe abrir un puerto, conectar a la BD ni correr el cron — los tests
// gestionan la conexión y la limpieza de la BD por su cuenta (ver tests/setup/db.ts).

//Global Middleware
app.use(helmet());
const corsOrigins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim());
// `exposedHeaders`: por defecto el navegador solo deja leer los headers seguros de la
// lista CORS, así que sin esto el `Idempotency-Replayed` de `POST /api/orders` (Fase O.2)
// llegaría a la respuesta pero el front no podría verlo.
app.use(cors({ origin: corsOrigins, exposedHeaders: ["Idempotency-Replayed"] }));

// Webhook de Stripe: la verificación de firma exige el cuerpo CRUDO, así que se
// monta con express.raw ANTES del express.json() global (que solo parsea el resto).
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhookRoutes);

// El límite por defecto de express.json() son 100 kb, y la confirmación de la importación
// masiva (POST /api/admin/products/import) manda hasta 500 filas de producto en un solo body.
// Un cuerpo mayor lo rechaza body-parser y errorHandler lo traduce a un 400 en español.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// API docs (Swagger UI + raw OpenAPI JSON). APAGADAS en producción salvo que se ponga
// API_DOCS_ENABLED=true: las rutas admin siguen exigiendo JWT, pero el spec le regala a
// cualquiera el mapa completo de endpoints, cuerpos y respuestas del panel (ver utils/env.ts
// para por qué el interruptor es una variable y no `requireAuth`). Sin montar, ambas caen en
// el 404 por defecto de Express.
if (apiDocsEnabled()) {
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get("/api/docs.json", (req, res) => {
    res.json(swaggerSpec);
  });
}

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
app.use("/api/admin/coupons", adminCouponRoutes);
app.use("/api/admin/expenses", adminExpenseRoutes);
app.use("/api/orders", orderRoutes); // checkout público
app.use("/api/shipping", shippingRoutes); // cotización en vivo, pública
app.use("/api/coupons", couponRoutes); // validación del cupón sin canjear, pública
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
// Verification route (liveness: "el proceso vive"). NO toca la BD a propósito — ver /health/ready.
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     summary: Readiness del servicio (¿puede atender tráfico?)
 *     description: >
 *       A diferencia de `/health` (liveness), consulta la base de datos bajo un timeout corto.
 *       Apunta aquí el *readiness probe* del orquestador: un `503` saca la instancia de rotación
 *       sin reiniciarla. También responde `503` mientras el proceso está apagándose.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: El servicio puede atender tráfico.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 database:
 *                   type: string
 *                   example: up
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       503:
 *         description: El servicio no puede atender tráfico (base de datos caída o apagado en curso).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: unavailable
 *                 database:
 *                   type: string
 *                   example: down
 *                 reason:
 *                   type: string
 *                   enum: [database, draining]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
// Readiness (Fase O.5). El handler no deja escapar ningún error: si pasara por `errorHandler`,
// cada sondeo con la BD caída mandaría un 500 a Sentry y devolvería copia de UI en español para
// algo que lee una máquina. El detalle del fallo va al log, nunca al cuerpo: es una ruta pública.
app.get("/health/ready", async (req, res) => {
  const timestamp = new Date().toISOString();

  // `checkReadiness` está escrita para no lanzar nunca; el try/catch sostiene esa garantía
  // desde este lado, para que la ruta no pueda degradarse a un 500 si eso cambiara.
  try {
    const { ready, reason } = await checkReadiness();

    if (ready) {
      res.json({ status: "ok", database: "up", timestamp });
      return;
    }

    res.status(503).json({
      status: "unavailable",
      database: reason === "database" ? "down" : "up",
      reason,
      timestamp,
    });
  } catch (err) {
    logger.error({ err }, "Readiness: el chequeo falló de forma inesperada");
    res.status(503).json({ status: "unavailable", database: "down", timestamp });
  }
});

app.use(errorHandler);

// Arranque real del servidor. Se omite por completo en entorno de test
// (`NODE_ENV === "test"`): Supertest importa el `app` de arriba sin abrir un puerto,
// conectar a la BD ni arrancar el sweeper. Todo lo que tiene efectos de proceso
// (listen, señales de apagado, pool de la BD) queda encapsulado aquí dentro.
if (process.env.NODE_ENV !== "test") {
  connectDB();
  startPendingOrderSweeper(); // libera stock de órdenes pending abandonadas (Stripe)
  startShipmentRetrySweeper(); // reintenta la guía de pedidos pagados que se quedaron sin ella
  startDailySalesDigest(); // resumen de ventas del día anterior al dueño (Fase N.4)

  const server = app.listen(PORT, () => {
    logger.info(`Server running at http://localhost:${PORT}`);
  });

  /**
   * Apagado ordenado (Fase H.5). Un redeploy envía `SIGTERM` (o `SIGINT` con Ctrl+C
   * en dev): en vez de morir de golpe a media transacción, se cierra en orden —
   *   0. poner el readiness en rojo (Fase O.5) para que el balanceador deje de mandar
   *      tráfico nuevo a esta instancia mientras drena,
   *   1. detener los sweepers (dejan de abrir trabajo nuevo),
   *   2. `server.close()` deja de aceptar conexiones y espera las requests en vuelo,
   *   3. cerrar el pool de Sequelize.
   * Un guard de timeout fuerza la salida si algo cuelga, para no dejar el proceso zombie.
   */
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return; // ignora señales repetidas
    isShuttingDown = true;
    markDraining(); // `GET /health/ready` responde 503 desde este instante, sin tocar la BD
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
      stopShipmentRetrySweeper();
      stopDailySalesDigest();
      logger.info("Crons de pendientes, guías y resumen diario detenidos");

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
