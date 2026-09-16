export interface RateLimitAttempt {
  scope: string;
  discriminator: string;
  max: number;
  windowSeconds: number;
}
