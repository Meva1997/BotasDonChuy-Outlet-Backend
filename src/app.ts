import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
import { connectDB } from "./config/database";
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
import { errorHandler } from "./middlewares/errorHandler";
import "./models/Product"; // register the model so sync() creates its table
import "./models/ProductSize";
import "./models/AdminUser";
import "./models/Order";
import "./models/OrderItem";
import "./models/BrandSettings";
import "./models/associations";

dotenv.config();

const app: Express = express();
const PORT = process.env.PORT || 4000;

connectDB();

//Global Middleware
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN }));
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
// Webhook de pagos. Fase 8: el webhook real de Stripe necesita el cuerpo crudo
// para verificar la firma, montando express.raw({ type: "application/json" })
// en esta ruta ANTES del express.json() global. El stub actual usa JSON.
app.use("/api/webhooks", webhookRoutes);

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

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

export default app;
