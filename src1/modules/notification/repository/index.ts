import { Service } from 'typedi';
import { Model } from 'mongoose';
import { NotificationModel } from '@/modules/notification/model';
import {
  INotification,
  NotificationQueryParams,
} from '@/modules/notification/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class NotificationRepository extends BaseRepository<INotification> {
  constructor() {
    super(NotificationModel as Model<INotification>);
  }

  async findByUserId(userId: string): Promise<INotification[]> {
    return this.findAll({ userId }, { sort: { createdAt: -1 } });
  }

  async findUnreadByUserId(userId: string): Promise<INotification[]> {
    return this.findAll(
      { userId, isRead: false },
      { sort: { createdAt: -1 } }
    );
  }

  async findByUserIdAndType(
    userId: string,
    type: string
  ): Promise<INotification[]> {
    return this.findAll(
      { userId, type },
      { sort: { createdAt: -1 } }
    );
  }

  async findByReference(
    referenceType: string,
    referenceId: string
  ): Promise<INotification[]> {
    return this.findAll(
      { referenceType, referenceId },
      { sort: { createdAt: -1 } }
    );
  }

  async markAsRead(id: string): Promise<INotification | null> {
    return this.update(
      { _id: id },
      { isRead: true, readAt: new Date() }
    );
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.updateMany(
      { userId, isRead: false },
      { isRead: true, readAt: new Date() }
    );
  }

  async getUnreadCount(userId: string): Promise<number> {
    const notifications = await this.findAll(
      { userId, isRead: false },
      { limit: 1000 }
    );
    return notifications.length;
  }

  async insertMany(docs: Partial<INotification>[]): Promise<number> {
    if (docs.length === 0) return 0;
    const result = await NotificationModel.insertMany(docs);
    return result.length;
  }

  async findWithPagination(
    filter: NotificationQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: INotification[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: any = {};

    if (filter.userId) {
      query.userId = filter.userId;
    }

    if (filter.type) {
      query.type = filter.type;
    }

    if (filter.isRead !== undefined) {
      query.isRead = filter.isRead;
    }

    if (filter.referenceType) {
      query.referenceType = filter.referenceType;
    }

    if (filter.referenceId) {
      query.referenceId = filter.referenceId;
    }

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1; // Most recent first
    }

    const [data, total] = await Promise.all([
      this.findAll(query, { skip, limit, sort }),
      NotificationModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
