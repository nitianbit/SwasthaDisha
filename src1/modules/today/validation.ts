import Joi from 'joi';

/** r37c/r38: the Today register's query (pharmacy and lab) and its search body (a POST: no phone or name in a URL). */
const fields = { date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/), cursor: Joi.string().pattern(/^\d{1,15}_[0-9a-fA-F]{24}$/),
  limit: Joi.number().integer().min(1).max(200), order: Joi.string().valid('asc', 'desc') };
export const todayQuerySchema = Joi.object(fields);
export const todaySearchSchema = Joi.object({ ...fields, q: Joi.string().trim().min(2).max(100).required() });
/** The page query as the register reads it. */
export const pageQueryOf = (q: Record<string, unknown>) => ({ date: q.date as string | undefined, cursor: q.cursor as string | undefined,
  limit: q.limit === undefined ? undefined : Number(q.limit), order: q.order as 'asc' | 'desc' | undefined });
