import type { NextFunction, Request, Response } from "express";

type AsyncRouteHandler<
  Req extends Request = Request,
  Res extends Response = Response,
> = (req: Req, res: Res, next: NextFunction) => Promise<unknown>;

export const asyncHandler =
  <Req extends Request = Request, Res extends Response = Response>(
    handler: AsyncRouteHandler<Req, Res>,
  ) =>
  (req: Req, res: Res, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
