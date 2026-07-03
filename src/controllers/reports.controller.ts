import type { Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler";
import * as reportsService from "../services/reports.service";

export const getMonthlyReport: RequestHandler = asyncHandler(
  async (_req: Request, res: Response) => {
    const data = await reportsService.getMonthlyReport();
    res.json(data);
  },
);

export const getReplenishmentReport: RequestHandler = asyncHandler(
  async (_req: Request, res: Response) => {
    const data = await reportsService.getReplenishmentReport();
    res.json(data);
  },
);
