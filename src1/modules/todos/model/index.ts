import { Schema, model, Model, Types } from 'mongoose';

/**
 * r37 (§26.20): an owner's to-do list (the Today register's "my to-dos"). One model for every owner kind: a pharmacy, a
 * lab, a clinic (shared by its staff) or a doctor (private); only the pharmacy's routes are mounted now. `text` is what
 * the user typed (never logged). Edits are fenced on `version`; a create is once per (owner, request key).
 */
export type TodoOwnerKind = 'pharmacy' | 'lab' | 'clinic' | 'doctor';
export const TODO_OWNER_KINDS: readonly TodoOwnerKind[] = ['pharmacy', 'lab', 'clinic', 'doctor'];

export interface ITodo {
  _id?: Types.ObjectId | string;
  owner: { kind: TodoOwnerKind; id: string };
  text: string;
  dueAt?: Date | null;
  done: boolean;
  doneAt?: Date | null;
  createdBy: { kind: string; id: string; name: string | null };
  requestKey: string;
  requestHash: string;
  version: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const todoSchema = new Schema<ITodo>(
  {
    owner: {
      kind: { type: String, required: true, enum: TODO_OWNER_KINDS },
      id: { type: String, required: true, lowercase: true },
    },
    text: { type: String, required: true, trim: true, maxlength: 200 },
    dueAt: { type: Date, default: null },
    done: { type: Boolean, required: true, default: false },
    doneAt: { type: Date, default: null },
    createdBy: {
      kind: { type: String, required: true },
      id: { type: String, required: true },
      name: { type: String, default: null },
    },
    requestKey: { type: String, required: true },
    requestHash: { type: String, required: true },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

// Once per (owner, request key). The owner's list is sorted open first, then newest (r37b: the list's own sort, so the
// unfiltered list and the `done` filter both read this index in order).
todoSchema.index({ 'owner.kind': 1, 'owner.id': 1, requestKey: 1 }, { unique: true });
todoSchema.index({ 'owner.kind': 1, 'owner.id': 1, done: 1, createdAt: -1, _id: -1 });

export const TodoModel: Model<ITodo> = model<ITodo>('Todo', todoSchema);
export default TodoModel;
