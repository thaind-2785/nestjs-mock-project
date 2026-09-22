/**
 * The one S3 client. Attachments and reports share it deliberately: two clients would
 * mean two connection pools and two shutdown paths against the same endpoint, and the
 * credentials are already one set.
 */
export const OBJECT_STORAGE_CLIENT = Symbol('OBJECT_STORAGE_CLIENT');
