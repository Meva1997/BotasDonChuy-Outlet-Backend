# Roadmaps completados

Bitácora de las hojas de ruta que guiaron el desarrollo del backend. Se archivan aquí, ya
cerradas, como registro histórico de decisiones y diseño — no como documentación activa (esa vive
en [`../CLAUDE.md`](../CLAUDE.md) y [`../README.md`](../README.md)).

| Documento | Alcance | Estado |
|---|---|---|
| [`ROADMAP.md`](ROADMAP.md) | Plan original del backend, fase por fase (auth, catálogo, checkout, dashboard, reportes, marca/usuarios, Skydropx, Stripe, emails) | ✅ Completo — queda 1 pendiente diferido a futuro (dominio Resend, ver `ROADMAP.md` §Fase 9) |
| [`roadmap-hardening.md`](roadmap-hardening.md) | Higiene operativa: testing, migraciones, rate limiting, logging/monitoreo, apagado ordenado, cancelación/reembolso manual, CI | ✅ Completo — queda 1 pendiente diferido a futuro (rate limit en catálogo público, ver Fase H.3) |
| [`roadmap-testing.md`](roadmap-testing.md) | Expansión ejecutable de la Fase H.1 — las 12 partes de la suite de tests | ✅ Completo |
| [`roadmap-skydropx.md`](roadmap-skydropx.md) | Integración de envíos en vivo con Skydropx (cotización, guía automática, webhook) | ✅ Completo |

**Roadmap activo:** [`../roadmap-operacion-y-negocio.md`](../roadmap-operacion-y-negocio.md) —
cierre operativo (bloque O, antes del lanzamiento) y features de negocio (bloque N).

**Pendientes diferidos a futuro** (no bloquean el desarrollo actual — lanzamiento planeado para el
1 de octubre, revisar cerca de esa fecha). Ambos se trackean ya en el roadmap activo, sección
*Pendientes heredados*:
- Verificar dominio en Resend (manual, fuera de código) — `ROADMAP.md` §Fase 9.
- Evaluar rate limiting en `GET /api/products`/`GET /api/products/:id` — `roadmap-hardening.md` §Fase H.3.
