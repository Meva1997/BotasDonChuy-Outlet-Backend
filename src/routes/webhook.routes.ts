import { Router } from "express";
import { stripeWebhook, skydropxWebhook } from "../controllers/order.controller";

const router: Router = Router();

/**
 * @openapi
 * /api/webhooks/stripe:
 *   post:
 *     summary: Webhook de pagos de Stripe
 *     description: >
 *       Endpoint que recibe los eventos de Stripe. La ruta se monta con
 *       `express.raw`, así que el cuerpo llega crudo y se verifica la firma del
 *       header `Stripe-Signature` con `STRIPE_WEBHOOK_SECRET` antes de procesar
 *       nada. Eventos manejados: `payment_intent.succeeded` (orden → `paid`),
 *       `payment_intent.payment_failed` (orden → `failed`, sigue `pending`) y
 *       `payment_intent.canceled` (restock + orden `cancelled`). Los demás eventos
 *       se aceptan (200) sin acción. **No es de uso manual**: lo invoca Stripe.
 *     tags: [Webhooks]
 *     parameters:
 *       - in: header
 *         name: Stripe-Signature
 *         required: true
 *         schema:
 *           type: string
 *         description: Firma del evento generada por Stripe.
 *     requestBody:
 *       required: true
 *       description: Cuerpo crudo del evento de Stripe (Event object). No parsear.
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Evento recibido (verificado). Puede o no haber tenido efecto.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 received:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Falta la firma o la verificación de la firma falló.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/stripe", stripeWebhook);

/**
 * @openapi
 * /api/webhooks/skydropx:
 *   post:
 *     summary: Webhook de estado de envíos de Skydropx
 *     description: >
 *       Endpoint que recibe los eventos de Skydropx (Fase 8.6). La ruta se monta
 *       con `express.raw`, así que el cuerpo llega crudo y se verifica la firma
 *       **HMAC-SHA512** del header `Authorization: HMAC <firma>` (calculada sobre el
 *       cuerpo crudo con `SKYDROPX_WEBHOOK_SECRET`, comparación en tiempo constante)
 *       antes de procesar nada. Evento manejado: `packages` — puebla
 *       `trackingNumber`/`trackingUrl`/`labelUrl` de la orden (la guía se crea de
 *       forma asíncrona y `POST /shipments` no los devuelve), avanza `status` a
 *       `shipped`/`delivered` y dispara el correo "pedido enviado" la primera vez que
 *       llega un número de guía. Los demás eventos se aceptan (200) sin acción.
 *       **No es de uso manual**: lo invoca Skydropx.
 *     tags: [Webhooks]
 *     parameters:
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema:
 *           type: string
 *         description: 'Firma HMAC del evento, con el formato `HMAC <firma>`.'
 *     requestBody:
 *       required: true
 *       description: Cuerpo crudo del evento de Skydropx (estilo JSON:API). No parsear.
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Evento recibido (verificado). Puede o no haber tenido efecto.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 received:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Falta la firma, tiene un formato inválido o la verificación falló.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/skydropx", skydropxWebhook);

export default router;
