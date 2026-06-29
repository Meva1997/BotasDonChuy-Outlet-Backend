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
      { name: "Auth", description: "Autenticación de administradores" },
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
      },
    },
  },
  // Globs relativos al cwd (raíz del backend) — válidos en dev (src/*.ts) y en prod (dist/*.js).
  apis: ["./src/routes/*.ts", "./src/app.ts", "./dist/routes/*.js", "./dist/app.js"],
};

export const swaggerSpec = swaggerJsdoc(options);
