import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import MemberModel from '@/modules/partners/model/member';

const service = () => Container.get(CatalogueService);

async function callerPartnerId(req: AuthRequest): Promise<string> {
  const memberId = req.user!.memberId!;
  const member = await MemberModel.findById(memberId).select('partnerId').lean();
  return String((member as any)?.partnerId);
}

export const listCatalogueItems = async (req: Request, res: Response, _next: NextFunction) => {
  const partnerId = await callerPartnerId(req as AuthRequest);
  const kind = req.query.kind as string | undefined;
  const data = await service().listItems(partnerId, kind as any);
  res.status(200).json({ success: true, data });
};

export const getCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const partnerId = await callerPartnerId(req as AuthRequest);
  const data = await service().getItem(partnerId, req.params.itemId);
  res.status(200).json({ success: true, data });
};

export const createCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const partnerId = await callerPartnerId(req as AuthRequest);
  const data = await service().createItem(partnerId, req.body);
  res.status(201).json({ success: true, data });
};

export const updateCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const partnerId = await callerPartnerId(req as AuthRequest);
  const data = await service().updateItem(partnerId, req.params.itemId, req.body);
  res.status(200).json({ success: true, data });
};

export const deactivateCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  const partnerId = await callerPartnerId(req as AuthRequest);
  await service().deactivateItem(partnerId, req.params.itemId);
  res.status(200).json({ success: true, message: 'Catalogue item deactivated' });
};

export const adminDisableCatalogueItem = async (req: Request, res: Response, _next: NextFunction) => {
  await service().adminDisableItem(req.params.itemId);
  res.status(200).json({ success: true, message: 'Catalogue item admin-disabled' });
};
