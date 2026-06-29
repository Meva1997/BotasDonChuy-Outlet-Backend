import { Router } from "express";
import { login, forgotPassword, me } from "../controllers/auth.controller";
import { requireAuth } from "../middlewares/requireAuth";
import { authRateLimiter } from "../middlewares/rateLimit";

const router: Router = Router();

router.post("/login", authRateLimiter, login);
router.post("/forgot-password", authRateLimiter, forgotPassword);
router.get("/me", requireAuth, me);

export default router;
