import type { Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler";
import * as dashboardService from "../services/dashboard.service";

export const getAdminDashboard: RequestHandler = asyncHandler(
  async (_req: Request, res: Response) => {
    const data = await dashboardService.getDashboardData();
    res.json(data);
  },
);
