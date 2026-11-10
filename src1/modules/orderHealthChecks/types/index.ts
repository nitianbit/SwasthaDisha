export interface IOrderHealthCheck {
  _id?: string;
  orderId: string;
  pharmacyId: string;
  userId: string;
  checkedBy: string;
  systolicBP?: number;
  diastolicBP?: number;
  fastingSugar?: number;
  postMealSugar?: number;
  hba1c?: number;
  notes?: string;
  checkedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateHealthCheckRequest {
  orderId: string;
  userId: string;
  systolicBP?: number;
  diastolicBP?: number;
  fastingSugar?: number;
  postMealSugar?: number;
  hba1c?: number;
  notes?: string;
}

export interface UpdateHealthCheckRequest {
  systolicBP?: number;
  diastolicBP?: number;
  fastingSugar?: number;
  postMealSugar?: number;
  hba1c?: number;
  notes?: string;
}
