import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AppVersionsService } from '@/modules/appVersions/services';
import { UpdateAppVersionSettingsRequest } from '@/modules/appVersions/types';

export class AppVersionsController {
  private appVersionsService: AppVersionsService;

  constructor() {
    this.appVersionsService = Container.get(AppVersionsService);
  }

  getSettings = async (_req: Request, res: Response, _next: NextFunction) => {
    const result = await this.appVersionsService.getSettings();

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  updateSettings = async (req: Request, res: Response, _next: NextFunction) => {
    const payload: UpdateAppVersionSettingsRequest = req.body;
    const result = await this.appVersionsService.updateSettings(payload);

    res.status(200).json({
      success: true,
      message: 'App version settings updated successfully',
      data: result,
    });
  };
}
