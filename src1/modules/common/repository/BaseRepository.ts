import {
  ClientSession,
  FilterQuery,
  LeanDocument,
  QueryOptions,
  SaveOptions,
  UpdateQuery,
  Model,
} from 'mongoose';

interface FindOptions {
  limit?: number;
  skip?: number;
  select?: any;
  sort?: any;
}

export default class BaseRepository<T> {
  private model: Model<T>;

  constructor(model: Model<T>) {
    this.model = model;
  }

  get = async (id: string, session?: ClientSession): Promise<LeanDocument<T> | null> => {
    const query = this.model.findById(id);
    if (session) {
      query.session(session);
    }
    return query.lean();
  };

  findOne = async (query: FilterQuery<T>, session?: ClientSession): Promise<LeanDocument<T> | null> => {
    const dbQuery = this.model.findOne(query);
    if (session) {
      dbQuery.session(session);
    }
    return dbQuery.lean();
  };

  findById = async (_id: string, session?: ClientSession): Promise<LeanDocument<T> | null> => {
    const query = this.model.findById(_id);
    if (session) {
      query.session(session);
    }
    return query.lean();
  };

  findAll = async (
    filter: FilterQuery<T> = {},
    options: FindOptions = {}
  ): Promise<LeanDocument<T>[]> => {
    const query = this.model.find(filter);
    if (options.limit) query.limit(options.limit);
    if (options.skip) query.skip(options.skip);
    if (options.select) query.select(options.select);
    if (options.sort) query.sort(options.sort);
    return query.lean();
  };

  save = async (data: Partial<T>, options: SaveOptions = {}): Promise<LeanDocument<T>> => {
    const instance = new this.model(data);
    return (await instance.save(options)).toObject();
  };

  update = async (
    query: FilterQuery<T>,
    data: Partial<T> | UpdateQuery<T>,
    options: QueryOptions = { new: true }
  ): Promise<LeanDocument<T> | null> => {
    return this.model.findOneAndUpdate(query, data, options).lean();
  };

  delete = async (query: FilterQuery<T>, options: QueryOptions = {}): Promise<void> => {
    await this.model.deleteOne(query, options);
  };

  deleteMany = async (query: FilterQuery<T>, options: QueryOptions = {}): Promise<void> => {
    await this.model.deleteMany(query, options);
  };

  updateMany = async (
    query: FilterQuery<T>,
    data: Partial<T> | UpdateQuery<T>,
    options: QueryOptions = {}
  ): Promise<any> => {
    return await this.model.updateMany(query, data, options);
  };

  findMany = (filter: FilterQuery<T>, projection?: any) => {
    return this.model.find(filter, projection);
  };
}
