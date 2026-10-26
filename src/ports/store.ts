// Where small durable records live: push subscriptions, keys, anything a plane or runner must keep
// across restarts. SQLite on one box is the first adapter; a hosted plane can bring another.

export interface StorePort {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  // Every key that starts with `prefix`, in key order.
  list(prefix: string): Promise<string[]>;
}
