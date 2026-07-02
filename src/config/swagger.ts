import swaggerJsdoc, { type Options } from "swagger-jsdoc";

const PORT = process.env.PORT || 4000;

const options: Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Botas Don Chuy Outlet API",
      version: "1.0.0",
      description:
        "API REST de la tienda Botas Don Chuy Outlet (productos tipo bota, " +
        "sombrero o ropa). Autenticación de administradores vía JWT Bearer.",
    },
    servers: [
      { url: `http://localhost:${PORT}`, description: "Desarrollo" },
    ],
    tags: [
      { name: "Products", description: "Catálogo público de productos" },
      { name: "Admin - Products", description: "CRUD de productos (requiere auth)" },
      { name: "Auth", description: "Autenticación de administradores" },
      { name: "Orders", description: "Checkout y pedidos del cliente" },
      { name: "Admin - Dashboard", description: "Métricas agregadas del panel (requiere auth)" },
      { name: "Admin - Orders", description: "Listado completo de pedidos con items (requiere auth)" },
      { name: "Webhooks", description: "Webhooks de pasarelas de pago" },
      { name: "Health", description: "Estado del servicio" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Pega el token devuelto por POST /api/auth/login",
        },
      },
      schemas: {
        // Producto tal como lo devuelve la API (sin unitCost, que se excluye en los controllers).
        Product: {
          type: "object",
          properties: {
            id: { type: "integer", example: 1 },
            name: { type: "string", example: "Bota vaquera de cuero" },
            description: {
              type: "string",
              nullable: true,
              example: "Bota artesanal de piel auténtica.",
            },
            originalPrice: { type: "number", format: "float", example: 1899.0 },
            salePrice: { type: "number", format: "float", example: 1499.0 },
            discountPercent: {
              type: "integer",
              readOnly: true,
              description: "Derivado de originalPrice y salePrice.",
              example: 21,
            },
            stock: {
              type: "integer",
              readOnly: true,
              description: "Total de existencias, derivado de productSizes.",
              example: 12,
            },
            type: {
              type: "string",
              enum: ["bota", "sombrero", "ropa"],
              example: "bota",
            },
            sizes: {
              type: "array",
              readOnly: true,
              description:
                "Tallas repetidas por unidad en stock (p. ej. [25, 25, 26]).",
              items: { type: "integer" },
              example: [25, 25, 26],
            },
            imageSrc: {
              type: "string",
              nullable: true,
              example: "https://res.cloudinary.com/demo/image/upload/bota.jpg",
            },
            code: { type: "string", nullable: true, example: "BTA-001" },
            weightKg: { type: "number", format: "float", example: 1.2 },
            lengthCm: { type: "number", format: "float", example: 30 },
            widthCm: { type: "number", format: "float", example: 12 },
            heightCm: { type: "number", format: "float", example: 35 },
            visible: { type: "boolean", example: true },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        ProductListResponse: {
          type: "object",
          properties: {
            products: {
              type: "array",
              items: { $ref: "#/components/schemas/Product" },
            },
            total: { type: "integer", example: 42 },
            page: { type: "integer", example: 1 },
            perPage: { type: "integer", example: 9 },
            totalPages: { type: "integer", example: 5 },
            availableSizes: {
              type: "array",
              items: { type: "integer" },
              description: "Tallas únicas disponibles entre los productos filtrados.",
              example: [25, 26, 27, 28],
            },
          },
        },
        LoginInput: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: {
              type: "string",
              format: "email",
              example: "admin@botasdonchuy.com",
            },
            password: {
              type: "string",
              format: "password",
              description:
                "Mín. 8 caracteres, al menos una mayúscula y un signo.",
              example: "Secreto_123",
            },
          },
        },
        ForgotPasswordInput: {
          type: "object",
          required: ["email"],
          properties: {
            email: {
              type: "string",
              format: "email",
              example: "admin@botasdonchuy.com",
            },
          },
        },
        AuthUser: {
          type: "object",
          properties: {
            id: { type: "string", example: "1" },
            name: { type: "string", example: "Don Chuy" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["owner", "admin"], example: "owner" },
          },
        },
        LoginResponse: {
          type: "object",
          properties: {
            token: {
              type: "string",
              description: "JWT firmado con JWT_SECRET.",
              example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
            },
            user: { $ref: "#/components/schemas/AuthUser" },
          },
        },
        ProductInput: {
          type: "object",
          required: [
            "name", "originalPrice", "salePrice", "unitCost",
            "type", "sizes", "weightKg", "lengthCm", "widthCm", "heightCm",
          ],
          properties: {
            name: { type: "string", example: "Bota vaquera de cuero" },
            description: { type: "string", nullable: true },
            originalPrice: { type: "number", format: "float", example: 1899 },
            salePrice: { type: "number", format: "float", example: 1499 },
            unitCost: { type: "number", format: "float", example: 800 },
            type: { type: "string", enum: ["bota", "sombrero", "ropa"] },
            sizes: {
              oneOf: [
                { type: "string", description: "Tallas separadas por coma, repetidas para indicar stock", example: "25, 25, 26" },
                { type: "array", items: { type: "integer" }, example: [25, 25, 26] },
              ],
            },
            imageSrc: { type: "string", nullable: true },
            code: { type: "string", nullable: true, example: "BTA-001" },
            weightKg: { type: "number", format: "float", example: 1.2 },
            lengthCm: { type: "number", format: "float", example: 30 },
            widthCm: { type: "number", format: "float", example: 12 },
            heightCm: { type: "number", format: "float", example: 35 },
            visible: { type: "boolean", default: true },
          },
        },
        CreateOrderInput: {
          type: "object",
          required: ["items", "customer"],
          properties: {
            items: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                required: ["productId", "size", "quantity"],
                properties: {
                  productId: { type: "integer", example: 1 },
                  size: { type: "integer", example: 26 },
                  quantity: {
                    type: "integer",
                    minimum: 1,
                    maximum: 99,
                    description:
                      "Tope duro de 99 por artículo; el límite real es el stock disponible de esa talla (un 409 si se excede).",
                    example: 1,
                  },
                },
              },
            },
            customer: { $ref: "#/components/schemas/ShippingInput" },
            shippingCarrier: { type: "string", nullable: true, example: "Estafeta" },
          },
        },
        ShippingInput: {
          type: "object",
          required: [
            "fullName", "email", "phone", "street",
            "neighborhood", "city", "state", "postalCode",
          ],
          properties: {
            fullName: { type: "string", example: "Juan Pérez" },
            email: { type: "string", format: "email", example: "juan@example.com" },
            phone: { type: "string", example: "4771234567", description: "10 dígitos." },
            street: { type: "string", example: "Av. Reforma 123" },
            neighborhood: { type: "string", example: "Centro" },
            city: { type: "string", example: "Celaya" },
            state: { type: "string", example: "Guanajuato", description: "Estado de la República." },
            postalCode: { type: "string", example: "38000", description: "5 dígitos." },
            references: { type: "string", nullable: true, example: "Casa azul, portón negro." },
          },
        },
        OrderItem: {
          type: "object",
          properties: {
            id: { type: "integer", example: 10 },
            orderId: { type: "integer", example: 5 },
            productId: { type: "integer", example: 1 },
            nameSnapshot: { type: "string", example: "Bota vaquera de cuero" },
            size: { type: "integer", example: 26 },
            quantity: { type: "integer", example: 1 },
            unitOriginalPrice: { type: "number", format: "float", example: 1899.0 },
            unitSalePrice: { type: "number", format: "float", example: 1499.0 },
            unitCost: { type: "number", format: "float", example: 800.0 },
          },
        },
        Order: {
          type: "object",
          properties: {
            id: { type: "integer", example: 5 },
            status: {
              type: "string",
              enum: ["pending", "paid", "shipped", "delivered", "cancelled"],
              example: "pending",
            },
            paymentStatus: {
              type: "string",
              enum: ["unpaid", "processing", "paid", "failed"],
              example: "unpaid",
            },
            paymentIntentId: { type: "string", nullable: true, example: null },
            subtotal: { type: "number", format: "float", example: 1899.0 },
            savings: { type: "number", format: "float", example: 400.0 },
            shipping: { type: "number", format: "float", example: 160.0 },
            total: { type: "number", format: "float", example: 1659.0 },
            customerName: { type: "string", example: "Juan Pérez" },
            customerEmail: { type: "string", format: "email" },
            customerPhone: { type: "string", example: "4771234567" },
            street: { type: "string", example: "Av. Reforma 123" },
            neighborhood: { type: "string", example: "Centro" },
            city: { type: "string", example: "Celaya" },
            state: { type: "string", example: "Guanajuato" },
            postalCode: { type: "string", example: "38000" },
            references: { type: "string", nullable: true },
            shippingCarrier: { type: "string", nullable: true, example: "Estafeta" },
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/OrderItem" },
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        OrderResponse: {
          type: "object",
          properties: {
            order: { $ref: "#/components/schemas/Order" },
            clientSecret: {
              type: "string",
              nullable: true,
              description: "Secreto del PaymentIntent de Stripe (null hasta Fase 8).",
              example: null,
            },
          },
        },
        Error: {
          type: "object",
          properties: {
            message: { type: "string", example: "Recurso no encontrado" },
            details: {
              type: "array",
              description: "Presente en errores de validación (ZodError).",
              items: {
                type: "object",
                properties: {
                  path: { type: "string", example: "email" },
                  message: { type: "string", example: "Datos inválidos" },
                },
              },
            },
          },
        },
        KpiData: {
          type: "object",
          properties: {
            label: { type: "string", example: "INGRESOS" },
            value: {
              type: "string",
              description: "Ya formateado en es-MX (moneda o porcentaje).",
              example: "$245,506.00",
            },
            trend: {
              type: "object",
              nullable: true,
              properties: {
                label: { type: "string", example: "+21% vs periodo anterior" },
                positive: { type: "boolean", example: true },
              },
            },
            subtitle: { type: "string", nullable: true, example: "12 jun" },
          },
        },
        RevenuePoint: {
          type: "object",
          properties: {
            date: { type: "string", description: "Etiqueta corta es-MX, p. ej. \"12 jun\".", example: "12 jun" },
            revenue: { type: "number", format: "float", example: 7420 },
          },
        },
        SaleRow: {
          type: "object",
          properties: {
            id: { type: "string", example: "5" },
            date: { type: "string", example: "12 jun · 07:33" },
            pieces: { type: "integer", example: 1 },
            items: { type: "string", example: "Bota Ranchera 1972, Bota Exótica de Avestruz ×2" },
            savings: { type: "number", format: "float", example: 400.0 },
            total: { type: "number", format: "float", example: 1659.0 },
            costoTotal: { type: "number", format: "float", example: 800.0 },
          },
        },
        InventoryRow: {
          type: "object",
          properties: {
            id: { type: "integer", example: 1 },
            name: { type: "string", example: "Bota vaquera de cuero" },
            type: { type: "string", enum: ["bota", "sombrero", "ropa"], example: "bota" },
            stock: { type: "integer", example: 12 },
            salePrice: { type: "number", format: "float", example: 1499.0 },
            unitCost: { type: "number", format: "float", example: 800.0 },
            valorInventario: {
              type: "number",
              format: "float",
              description: "stock × unitCost",
              example: 9600.0,
            },
          },
        },
        DashboardData: {
          type: "object",
          properties: {
            kpis: { type: "array", items: { $ref: "#/components/schemas/KpiData" } },
            profitKpis: { type: "array", items: { $ref: "#/components/schemas/KpiData" } },
            revenueByPeriod: {
              type: "object",
              description: "Las tres series juntas; el front alterna en cliente.",
              properties: {
                "7": { type: "array", items: { $ref: "#/components/schemas/RevenuePoint" } },
                "30": { type: "array", items: { $ref: "#/components/schemas/RevenuePoint" } },
                "90": { type: "array", items: { $ref: "#/components/schemas/RevenuePoint" } },
              },
            },
            recentSales: { type: "array", items: { $ref: "#/components/schemas/SaleRow" } },
            inventory: { type: "array", items: { $ref: "#/components/schemas/InventoryRow" } },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: "Token ausente o inválido.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        NotFound: {
          description: "Recurso no encontrado.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        ValidationError: {
          description: "Error de validación (campos inválidos).",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  },
  // Globs relativos al cwd (raíz del backend) — válidos en dev (src/*.ts) y en prod (dist/*.js).
  apis: ["./src/routes/*.ts", "./src/app.ts", "./dist/routes/*.js", "./dist/app.js"],
};

export const swaggerSpec = swaggerJsdoc(options);
