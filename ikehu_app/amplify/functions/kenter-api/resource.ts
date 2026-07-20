import { defineFunction, secret } from '@aws-amplify/backend';

export const kenterApi = defineFunction({
  name: 'kenter-api',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 30,
  memoryMB: 512,
  environment: {
    KENTER_CLIENT_ID: secret('KENTER_CLIENT_ID'),
    KENTER_CLIENT_SECRET: secret('KENTER_CLIENT_SECRET'),
    ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN ?? '*',
  },
});

