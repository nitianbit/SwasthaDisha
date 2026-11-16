import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { actorOf } from '@/modules/partners/controller';

const service = () => Container.get(CatalogueService);

export const listCatalogueItems = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().listItems(actorOf(req), req.query.kind as any, req.query.includeInactive === 'true', req.query.q as string | undefined);
  res.status(200).json({ success: true, data });
};

export const catalogueItemByKey = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().findByKey(actorOf(req), req.params.key);
  if (!data) { res.status(404).json({ error: 404, code: 'ITEM_NOT_FOUND', message: 'No item was made with this key' }); return; }
  res.status(200).json({ success: true, data });
};

export const abandonCatalogueKey = async (req: Request, res: Response, _next: NextFunction) => {
  res.status(200).json({ success: true, data: await service().abandonKey(actorOf(req), req.params.key) });
};

export const getCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().getItem(actorOf(req), req.params.itemId);
  res.status(200).json({ success: true, data });
};

export const createCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const { replayed, ...data } = await service().createItem(actorOf(req), req.body) as any;
  res.status(replayed ? 200 : 201).json({ success: true, data });
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

export const reactivateCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().reactivateItem(actorOf(req), req.params.itemId);
  res.status(200).json({ success: true, data });
};
