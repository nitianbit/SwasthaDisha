import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { actorOf } from '@/modules/partners/controller';

const service = () => Container.get(CatalogueService);

export const listCatalogueItems = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().listItems(actorOf(req), req.query.kind as any);
  res.status(200).json({ success: true, data });
};

export const getCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().getItem(actorOf(req), req.params.itemId);
  res.status(200).json({ success: true, data });
};

export const createCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().createItem(actorOf(req), req.body);
  res.status(201).json({ success: true, data });
};

export const updateCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().updateItem(actorOf(req), req.params.itemId, req.body);
  res.status(200).json({ success: true, data });
};

export const deactivateCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  await service().deactivateItem(actorOf(req), req.params.itemId);
  res.status(200).json({ success: true, message: 'Catalogue item deactivated' });
};

export const adminDisableCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().setAdminDisabled(String((req as AuthRequest).user!._id), req.params.itemId, true);
  res.status(200).json({ success: true, data });
};

export const adminEnableCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().setAdminDisabled(String((req as AuthRequest).user!._id), req.params.itemId, false);
  res.status(200).json({ success: true, data });
};
