import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/lib/captures/postgres*.integration.test.ts', 'src/lib/captures/cancellation.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.REMINDME_TEST_DATABASE_URL ?? 'postgres://openbin_test:openbin_test@127.0.0.1:5433/remindme_capture_test',
      DATABASE_PATH: ':memory:',
      JWT_SECRET: 'capture-postgres-integration-test',
      ADMIN_PASSWORD: 'capture-postgres-test-admin',
      ADMIN_EMAIL: 'capture-pg-admin@test.invalid',
      REMINDME_LOCAL_MODE: 'false',
      PHOTO_STORAGE_PATH: '/tmp/remindme-pg-permanent-test',
      CAPTURE_SCRATCH_QUOTA_BYTES: '4096',
      CAPTURE_HEADROOM_BYTES: '0',
      CAPTURE_MIN_FREE_DISK_BYTES: '0',
    },
  },
});
