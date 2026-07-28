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
      { name: "Shipping", description: "Cotización de envío en vivo (Skydropx)" },
      { name: "Admin - Dashboard", description: "Métricas agregadas del panel (requiere auth)" },
      { name: "Admin - Orders", description: "Listado completo de pedidos con items (requiere auth)" },
      { name: "Admin - Reports", description: "Reportes de ventas y reposición (requiere auth)" },
      { name: "Admin - Brand", description: "Identidad de marca (lectura pública, escritura autenticada)" },
      { name: "Admin - Users", description: "Gestión de usuarios del panel (requiere auth)" },
      { name: "Admin - Account", description: "Cuenta propia del administrador autenticado" },
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
              readOnly: true,
              description:
                "Derivado de images[0].url (primera imagen). Campo calculado de solo lectura: las imágenes se gestionan por POST/DELETE /api/admin/products/{id}/images.",
              example: "https://res.cloudinary.com/demo/image/upload/bota.jpg",
            },
            images: {
              type: "array",
              readOnly: true,
              description:
                "Galería de hasta 3 imágenes en Cloudinary. Se gestiona por los endpoints dedicados, no por POST/PUT del producto.",
              items: {
                type: "object",
                properties: {
                  url: {
                    type: "string",
                    example: "https://res.cloudinary.com/demo/image/upload/v1/botasdonchuy/products/abc.jpg",
                  },
                  publicId: { type: "string", example: "botasdonchuy/products/abc" },
                },
              },
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
        VerifyResetCodeInput: {
          type: "object",
          required: ["email", "code"],
          properties: {
            email: {
              type: "string",
              format: "email",
              example: "admin@botasdonchuy.com",
            },
            code: {
              type: "string",
              description: "Código de 5 dígitos numéricos recibido por correo.",
              example: "04829",
            },
          },
        },
        ResetPasswordInput: {
          type: "object",
          required: ["email", "code", "newPassword", "confirmPassword"],
          properties: {
            email: {
              type: "string",
              format: "email",
              example: "admin@botasdonchuy.com",
            },
            code: {
              type: "string",
              description: "Código de 5 dígitos numéricos recibido por correo.",
              example: "04829",
            },
            newPassword: {
              type: "string",
              format: "password",
              description:
                "Mín. 8 caracteres, al menos una mayúscula, un número y un signo.",
              example: "NuevoSecreto_123",
            },
            confirmPassword: {
              type: "string",
              format: "password",
              description: "Debe coincidir con newPassword.",
              example: "NuevoSecreto_123",
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
            code: { type: "string", nullable: true, example: "BTA-001" },
            weightKg: { type: "number", format: "float", example: 1.2 },
            lengthCm: { type: "number", format: "float", example: 30 },
            widthCm: { type: "number", format: "float", example: 12 },
            heightCm: { type: "number", format: "float", example: 35 },
            visible: { type: "boolean", default: true },
          },
        },
        ProductImportSummary: {
          type: "object",
          properties: {
            total: { type: "integer" },
            created: { type: "integer" },
            updated: { type: "integer" },
            unchanged: {
              type: "integer",
              description: "Filas que emparejan con un producto pero no cambian ningún valor.",
            },
            failed: { type: "integer" },
          },
        },
        ProductImportRowInput: {
          type: "object",
          description:
            "Una fila de la importación. Todos los campos son opcionales y sin valor por defecto: " +
            "una clave AUSENTE significa \"no toques esa columna del producto\". Enviar `null` " +
            "equivale a omitirla. No se aceptan claves desconocidas (400).",
          properties: {
            row: { type: "integer", description: "Número de fila en la hoja, solo para los mensajes.", example: 2 },
            code: { type: "string", maxLength: 40, example: "BTA-100" },
            name: { type: "string", example: "Bota vaquera de cuero" },
            description: { type: "string" },
            type: { type: "string", enum: ["bota", "sombrero", "ropa"] },
            originalPrice: { type: "number", example: 2400 },
            salePrice: { type: "number", example: 1920 },
            unitCost: { type: "number", example: 950 },
            sizes: {
              oneOf: [{ type: "string" }, { type: "array", items: { type: "integer" } }],
              description:
                'Tallas a SUMAR al stock. "25, 26, 26" (una ocurrencia = una unidad) o ' +
                '"26x20" (20 piezas de la 26); ambas notaciones se pueden mezclar.',
              example: "25x3, 26x5, 27",
            },
            weightKg: { type: "number", example: 1.5 },
            lengthCm: { type: "number", example: 34 },
            widthCm: { type: "number", example: 22 },
            heightCm: { type: "number", example: 14 },
            visible: { type: "boolean" },
          },
        },
        ProductImportCommitInput: {
          type: "object",
          required: ["rows"],
          properties: {
            rows: {
              type: "array",
              minItems: 1,
              maxItems: 500,
              description: "Los `input` devueltos por /import/preview, con las ediciones del dueño.",
              items: { $ref: "#/components/schemas/ProductImportRowInput" },
            },
          },
        },
        ProductImportSnapshot: {
          type: "object",
          description: "Foto de un producto: su estado actual (`before`) o cómo quedaría (`after`).",
          properties: {
            id: { type: "integer", nullable: true, description: "`null` cuando el producto aún no existe." },
            code: { type: "string", nullable: true },
            name: { type: "string" },
            type: { type: "string", enum: ["bota", "sombrero", "ropa"] },
            description: { type: "string", nullable: true },
            originalPrice: { type: "number" },
            salePrice: { type: "number" },
            unitCost: { type: "number" },
            weightKg: { type: "number" },
            lengthCm: { type: "number" },
            widthCm: { type: "number" },
            heightCm: { type: "number" },
            visible: { type: "boolean" },
            discontinued: { type: "boolean", description: "Producto con soft-delete (`deletedAt`)." },
            sizes: {
              type: "array",
              items: {
                type: "object",
                properties: { size: { type: "integer" }, stock: { type: "integer" } },
              },
            },
            stock: { type: "integer", description: "Suma del stock de todas las tallas." },
          },
        },
        ProductImportRowPlan: {
          type: "object",
          properties: {
            row: { type: "integer", description: "Número de fila en la hoja (1 = encabezado).", example: 2 },
            action: {
              type: "string",
              enum: ["create", "update", "unchanged", "error"],
              description: "`unchanged`: la fila empareja pero no cambia ningún valor.",
            },
            code: { type: "string", nullable: true },
            name: { type: "string", nullable: true },
            productId: { type: "integer", nullable: true },
            before: {
              allOf: [{ $ref: "#/components/schemas/ProductImportSnapshot" }],
              nullable: true,
              description: "Estado actual. `null` si la fila va a crear el producto.",
            },
            after: {
              allOf: [{ $ref: "#/components/schemas/ProductImportSnapshot" }],
              nullable: true,
              description: "Cómo quedaría al confirmar. `null` en las filas con error.",
            },
            changes: {
              type: "array",
              description: "Solo los campos escalares que realmente cambian.",
              items: {
                type: "object",
                properties: {
                  field: { type: "string", example: "salePrice" },
                  label: { type: "string", example: "Precio oferta" },
                  before: {},
                  after: {},
                },
              },
            },
            sizeChanges: {
              type: "array",
              description: "Stock por talla: `added` se SUMA a `before`.",
              items: {
                type: "object",
                properties: {
                  size: { type: "integer", example: 26 },
                  before: { type: "integer", example: 3 },
                  added: { type: "integer", example: 5 },
                  after: { type: "integer", example: 8 },
                },
              },
            },
            reactivated: {
              type: "boolean",
              description: "La fila reactivará un producto descontinuado.",
            },
            warnings: {
              type: "array",
              items: { type: "string" },
              description:
                "Interpretaciones que conviene confirmar (coma decimal, celda con formato de " +
                "fecha, código que solo difiere en mayúsculas) o aviso de que la fila no cambia nada.",
            },
            message: { type: "string", example: 'Fila 2: se actualizará "Bota vaquera de cuero".' },
            input: {
              allOf: [{ $ref: "#/components/schemas/ProductImportRowInput" }],
              description: "La fila a devolver (editada si hace falta) en POST /api/admin/products/import.",
            },
          },
        },
        ProductImportPreviewResponse: {
          type: "object",
          properties: {
            summary: { $ref: "#/components/schemas/ProductImportSummary" },
            warnings: {
              type: "array",
              items: { type: "string" },
              description: "Avisos del archivo completo, p. ej. columnas no reconocidas.",
              example: ['Estas columnas no se reconocieron y NO se van a importar: "Proveedor".'],
            },
            rows: {
              type: "array",
              items: { $ref: "#/components/schemas/ProductImportRowPlan" },
            },
          },
        },
        ProductImportRowResult: {
          type: "object",
          properties: {
            row: { type: "integer", description: "Número de fila en la hoja (1 = encabezado).", example: 2 },
            status: { type: "string", enum: ["created", "updated", "unchanged", "error"] },
            code: { type: "string", nullable: true },
            name: { type: "string", nullable: true },
            productId: { type: "integer", nullable: true },
            message: { type: "string", example: 'Fila 2: producto "Bota vaquera de cuero" actualizado.' },
          },
        },
        ProductImportResponse: {
          type: "object",
          properties: {
            summary: { $ref: "#/components/schemas/ProductImportSummary" },
            rows: {
              type: "array",
              items: { $ref: "#/components/schemas/ProductImportRowResult" },
            },
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
            quotationId: {
              type: "string",
              nullable: true,
              description:
                "id de cotización de Skydropx (de POST /api/shipping/rates). Debe ir junto con rateId, o ninguno. El servidor re-consulta la cotización y cobra el total autoritativo de ese rate; si se omiten, cobra la tarifa plana.",
              example: "quot_5b2e1f",
            },
            rateId: {
              type: "string",
              nullable: true,
              description:
                "id del rate elegido dentro de la cotización. Debe ir junto con quotationId, o ninguno.",
              example: "rate_9f8a3c",
            },
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
              enum: ["unpaid", "processing", "paid", "failed", "refunded"],
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
            skydropxQuotationId: {
              type: "string",
              nullable: true,
              description:
                "Cotización de Skydropx usada para el envío. null cuando la orden usó la tarifa plana de respaldo.",
              example: "quot_5b2e1f",
            },
            skydropxRateId: {
              type: "string",
              nullable: true,
              description: "Rate elegido dentro de la cotización. null en tarifa plana.",
              example: "rate_9f8a3c",
            },
            shippingRequiresDropoff: {
              type: "boolean",
              nullable: true,
              description:
                "Dato operativo SOLO para el panel admin (se excluye de la respuesta pública de POST /api/orders): true = la paquetería elegida no recoge a domicilio, el dueño debe llevar el paquete a su sucursal. null cuando la orden usó la tarifa plana de respaldo o es previa a esta columna.",
              example: false,
            },
            skydropxShipmentId: {
              type: "string",
              nullable: true,
              description:
                "id de la guía (shipment) creada en Skydropx al confirmarse el pago. null antes de pagar, si la orden usó la tarifa plana de respaldo (sin rate de Skydropx que convertir en guía), o mientras se reclama con el valor centinela \"creating\" (ver createShipmentForOrder).",
              example: "ship_7c1a9e",
            },
            trackingNumber: {
              type: "string",
              nullable: true,
              description:
                "Número de guía. La creación de la guía es asíncrona: queda null hasta que el webhook de Skydropx (POST /api/webhooks/skydropx) lo reporte.",
              example: "ESF1234567890",
            },
            trackingUrl: {
              type: "string",
              nullable: true,
              description: "URL de rastreo de la paquetería. Igual que trackingNumber, la llena el webhook de Skydropx.",
              example: "https://www.estafeta.com/Rastreo/ESF1234567890",
            },
            labelUrl: {
              type: "string",
              nullable: true,
              description: "URL de la etiqueta/guía imprimible. La llena el webhook de Skydropx.",
              example: "https://cdn.skydropx.com/labels/ship_7c1a9e.pdf",
            },
            shipmentStatus: {
              type: "string",
              nullable: true,
              description:
                "Último estado crudo reportado por el webhook de Skydropx (p. ej. \"in_transit\", \"delivered\"). null hasta el primer evento.",
              example: "in_transit",
            },
            refundId: {
              type: "string",
              nullable: true,
              description:
                "id del reembolso de Stripe (re_...). Solo se puebla al cancelar manualmente una orden pagada (POST /api/admin/orders/:id/cancel); null en cualquier otro caso.",
              example: "re_3Abc123",
            },
            refundedAt: {
              type: "string",
              format: "date-time",
              nullable: true,
              description: "Momento en que se aplicó el reembolso. null si la orden no se reembolsó.",
            },
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
              description:
                "Secreto del PaymentIntent de Stripe; el cliente lo usa para confirmar el pago.",
              example: "pi_3Abc123_secret_XyZ",
            },
          },
        },
        CancelOrderInput: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              maxLength: 200,
              description:
                "Motivo opcional de la cancelación, para el registro (p. ej. \"el cliente pidió cancelar por WhatsApp\").",
              example: "El cliente pidió cancelar por WhatsApp",
            },
          },
        },
        OrderStatusUpdateInput: {
          type: "object",
          required: ["status"],
          properties: {
            status: {
              type: "string",
              enum: ["shipped", "delivered"],
              description:
                "Estado destino. Solo hacia adelante: `cancelled` no se maneja aquí (usa POST /api/admin/orders/{id}/cancel, el único camino que reembolsa y restockea) y `pending`/`paid` los fija el flujo de pago.",
              example: "shipped",
            },
            trackingNumber: {
              type: "string",
              maxLength: 100,
              description:
                "Número de guía capturado a mano. Al registrarse por primera vez dispara el correo \"tu pedido va en camino\" (una sola vez por pedido, compartido con el webhook de Skydropx). Opcional: marcar `delivered` sin guía es válido (entrega en mano o local).",
              example: "7891234567",
            },
            trackingUrl: {
              type: "string",
              format: "uri",
              maxLength: 500,
              description: "Enlace de rastreo de la paquetería, si lo hay.",
              example: "https://rastreo.paqueteria.mx/7891234567",
            },
            shippingCarrier: {
              type: "string",
              maxLength: 80,
              description:
                "Paquetería con la que se envió. Sobrescribe la guardada en el pedido (útil cuando se envió por una distinta a la cotizada).",
              example: "Estafeta",
            },
          },
        },
        ShippingRatesInput: {
          type: "object",
          required: ["customer", "items"],
          properties: {
            customer: { $ref: "#/components/schemas/ShippingInput" },
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
                  quantity: { type: "integer", minimum: 1, maximum: 99, example: 1 },
                },
              },
            },
          },
        },
        ShippingRate: {
          type: "object",
          properties: {
            rateId: {
              type: "string",
              nullable: true,
              description: "null cuando es la tarifa plana de respaldo (Skydropx no disponible).",
              example: "rate_9f8a3c",
            },
            carrier: { type: "string", example: "Estafeta" },
            service: { type: "string", example: "Terrestre" },
            amount: { type: "number", format: "float", example: 145.0 },
            total: { type: "number", format: "float", example: 145.0 },
            days: {
              type: "integer",
              nullable: true,
              description: "Días estimados de entrega; null en la tarifa plana de respaldo.",
              example: 3,
            },
            requiresDropoff: {
              type: "boolean",
              description:
                "true = el servicio no incluye recolección a domicilio (el paquete se lleva a la sucursal). Dato operativo para el dueño; el checkout no necesita mostrarlo. Se persiste en la orden como shippingRequiresDropoff.",
              example: false,
            },
          },
        },
        ShippingRatesResponse: {
          type: "object",
          properties: {
            quotationId: {
              type: "string",
              nullable: true,
              description:
                "id de la cotización en Skydropx. null cuando se usó la tarifa plana de respaldo (falla, timeout, o sin tarifas utilizables a tiempo).",
              example: "quot_5b2e1f",
            },
            rates: {
              type: "array",
              description:
                "Al menos un rate siempre presente: la tarifa plana de respaldo (carrier \"Estándar\", rateId null) si Skydropx no pudo cotizar.",
              items: { $ref: "#/components/schemas/ShippingRate" },
            },
          },
        },
        Error: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description:
                "Mensaje accionable en español, listo para mostrarse al usuario final. En " +
                "errores de validación resume los mensajes por campo (máximo 3, luego " +
                '"(y N campos más por corregir)").',
              example:
                'Solo queda 1 pieza de "Bota Bordada Tejana" en talla 24. Ajusta la cantidad para continuar.',
            },
            details: {
              type: "array",
              description:
                "Presente en errores de validación (ZodError): el desglose completo por campo. " +
                "`message` ya resume estos mismos mensajes, así que consumirlo es opcional.",
              items: {
                type: "object",
                properties: {
                  path: { type: "string", example: "customer.phone" },
                  message: { type: "string", example: "El teléfono debe tener 10 dígitos" },
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
            kpisByPeriod: {
              type: "object",
              description: "Las tres ventanas juntas; el front alterna en cliente.",
              properties: {
                "7": { type: "array", items: { $ref: "#/components/schemas/KpiData" } },
                "30": { type: "array", items: { $ref: "#/components/schemas/KpiData" } },
                "90": { type: "array", items: { $ref: "#/components/schemas/KpiData" } },
              },
            },
            profitKpisByPeriod: {
              type: "object",
              description: "Las tres ventanas juntas; el front alterna en cliente.",
              properties: {
                "7": { type: "array", items: { $ref: "#/components/schemas/KpiData" } },
                "30": { type: "array", items: { $ref: "#/components/schemas/KpiData" } },
                "90": { type: "array", items: { $ref: "#/components/schemas/KpiData" } },
              },
            },
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
        MonthlyProductSales: {
          type: "object",
          properties: {
            productId: { type: "integer", example: 1 },
            name: { type: "string", example: "Bota vaquera de cuero" },
            type: { type: "string", enum: ["bota", "sombrero", "ropa"], example: "bota" },
            unitsSold: { type: "integer", example: 4 },
            revenue: {
              type: "number",
              format: "float",
              description: "unitsSold × salePrice (sin redondear).",
              example: 5996.0,
            },
            unitCost: { type: "number", format: "float", example: 800.0 },
          },
        },
        MonthlyCategoryBreakdown: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["bota", "sombrero", "ropa"], example: "bota" },
            label: { type: "string", description: "Etiqueta plural.", example: "Botas" },
            revenue: { type: "number", format: "float", example: 12480.0 },
            units: { type: "integer", example: 9 },
          },
        },
        MonthlyReport: {
          type: "object",
          properties: {
            key: { type: "string", description: "Mes en formato YYYY-MM (UTC).", example: "2026-01" },
            label: { type: "string", example: "Enero 2026" },
            partial: {
              type: "boolean",
              description: "true solo para el mes en curso (datos incompletos).",
              example: false,
            },
            totalRevenue: { type: "number", format: "float", example: 18476.0 },
            totalUnits: { type: "integer", example: 17 },
            byProduct: { type: "array", items: { $ref: "#/components/schemas/MonthlyProductSales" } },
            byCategory: { type: "array", items: { $ref: "#/components/schemas/MonthlyCategoryBreakdown" } },
          },
        },
        ReplenishmentRow: {
          type: "object",
          properties: {
            productId: { type: "integer", example: 2 },
            name: { type: "string", example: "Sombrero de fieltro" },
            type: { type: "string", enum: ["bota", "sombrero", "ropa"], example: "sombrero" },
            currentStock: { type: "integer", example: 1 },
            forecastNextMonth: { type: "integer", example: 5 },
            forecastMethod: {
              type: "string",
              enum: ["promedio-simple", "tendencia", "suavizacion-exponencial"],
              example: "suavizacion-exponencial",
            },
            forecastMethodLabel: { type: "string", example: "Suavización exponencial" },
            trend: {
              type: "string",
              enum: ["creciendo", "estable", "bajando"],
              example: "creciendo",
            },
            confidence: { type: "string", enum: ["baja", "media", "alta"], example: "alta" },
            diasCobertura: {
              type: "integer",
              description: "999 = sin ventas pronosticadas (sentinela).",
              example: 6,
            },
            ingresoMensual: { type: "integer", example: 5996 },
            margenMensual: { type: "integer", example: 3196 },
            suggestedOrder: { type: "integer", example: 9 },
            costoEstimadoPedido: { type: "number", format: "float", example: 7200.0 },
            priority: { type: "string", enum: ["urgente", "pronto", "ok"], example: "urgente" },
          },
        },
        BrandSettings: {
          type: "object",
          properties: {
            id: { type: "integer", example: 1 },
            brandName: { type: "string", example: "Botas Don Chuy Outlet" },
            heroText: { type: "string", example: "Liquidación final · Sin reposición" },
            tagline: {
              type: "string",
              description: "Salto de línea (\\n) separa cada línea del tagline.",
              example: "Piezas únicas. Sin reposición.\nCuando se acaba, se acaba.",
            },
            cartNotice: { type: "string", example: "Estos artículos no se reservan" },
            footerNote: {
              type: "string",
              example: "Liquidación de inventario · piezas finales · sin reposición",
            },
            logoUrl: {
              type: "string",
              nullable: true,
              readOnly: true,
              description:
                "URL del logo en Cloudinary. Solo lectura: se gestiona por POST/DELETE /api/admin/brand/logo, no por PUT.",
              example: null,
            },
            logoPublicId: {
              type: "string",
              nullable: true,
              readOnly: true,
              description: "public_id de Cloudinary del logo (para borrarlo al reemplazar).",
              example: null,
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        BrandSettingsUpdateInput: {
          type: "object",
          description:
            "Update parcial de textos — envía solo los campos que cambian. El logo NO se maneja aquí (ver POST/DELETE /api/admin/brand/logo).",
          properties: {
            brandName: { type: "string", example: "Botas Don Chuy Outlet" },
            heroText: { type: "string", example: "Liquidación final · Sin reposición" },
            tagline: { type: "string", example: "Piezas únicas. Sin reposición.\nCuando se acaba, se acaba." },
            cartNotice: { type: "string", example: "Estos artículos no se reservan" },
            footerNote: { type: "string", example: "Liquidación de inventario · piezas finales · sin reposición" },
          },
        },
        AdminUser: {
          type: "object",
          description: "No incluye passwordHash.",
          properties: {
            id: { type: "integer", example: 1 },
            name: { type: "string", example: "Don Chuy" },
            email: { type: "string", format: "email", example: "admin@botasdonchuy.com" },
            role: { type: "string", enum: ["owner", "admin"], example: "owner" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateAdminUserInput: {
          type: "object",
          required: ["name", "email", "tempPassword"],
          properties: {
            name: { type: "string", example: "Nuevo Admin" },
            email: { type: "string", format: "email", example: "nuevo@botasdonchuy.com" },
            tempPassword: {
              type: "string",
              format: "password",
              description: "Mín. 8 caracteres, con al menos una mayúscula y un signo (mismo criterio que el login).",
              example: "Temporal123!",
            },
            role: { type: "string", enum: ["owner", "admin"], default: "admin" },
          },
        },
        UpdateAccountInput: {
          type: "object",
          required: ["currentPassword"],
          properties: {
            currentPassword: { type: "string", format: "password" },
            email: { type: "string", format: "email", example: "nuevo@botasdonchuy.com" },
            newPassword: {
              type: "string",
              format: "password",
              description: "Mín. 8 caracteres, con al menos una mayúscula y un signo (mismo criterio que el login).",
            },
            confirmPassword: { type: "string", format: "password" },
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
