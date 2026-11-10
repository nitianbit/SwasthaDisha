import { Schema, model, Model } from 'mongoose';
import { INews } from '@/modules/news/types';

const newsSchema = new Schema<INews>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    image: {
      type: String,
      trim: true,
    },
    link: {
      type: String,
      trim: true,
    },
    publishedAt: {
      type: String,
      match: /^\d{8}$/,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

newsSchema.index({ createdAt: -1 });
newsSchema.index({ publishedAt: -1 });
newsSchema.index({ title: 'text', description: 'text' });

const NewsModel: Model<INews> = model<INews>('News', newsSchema);

export default NewsModel;
