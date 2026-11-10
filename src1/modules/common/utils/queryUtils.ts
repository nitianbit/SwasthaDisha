export const buildContainsRegex = (value: string): { $regex: string; $options: 'i' } => ({
  $regex: value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  $options: 'i',
});
