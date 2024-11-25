export interface ProductData {
  id: string;
  title: string;
  description?: string;
  price: number;
  // Add more fields as needed
}

export interface SyncEvent {
  source: 'shopline' | 'bwp';
  action: 'create' | 'update' | 'delete';
  productId: string;
  data?: ProductData;
}
