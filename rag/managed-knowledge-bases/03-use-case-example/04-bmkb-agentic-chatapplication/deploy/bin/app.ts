#!/usr/bin/env node
/**
 * CDK app entry. Instantiates the single BmkbStack.
 *
 * Account/region come from CDK_DEFAULT_* (see .env.example). This sample was
 * verified in us-west-2.
 */
import * as cdk from 'aws-cdk-lib';

import { BmkbStack } from '../lib/bmkb-stack.js';

const app = new cdk.App();

const account = process.env['CDK_DEFAULT_ACCOUNT'];
const region = process.env['CDK_DEFAULT_REGION'] ?? 'us-west-2';

// `exactOptionalPropertyTypes` rejects an explicit `undefined` account; omit the
// key entirely when unset so CDK falls back to environment-agnostic synth.
const env: cdk.Environment = account !== undefined ? { account, region } : { region };

const allowedOrigins = (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

new BmkbStack(app, 'BmkbStack', {
  env,
  allowedOrigins,
  // Open self-registration is opt-in: a public sign-up on a Bedrock-backed
  // API is a cost-abuse vector. Set ALLOW_SELF_SIGNUP=true for open demos.
  selfSignUpEnabled: process.env['ALLOW_SELF_SIGNUP'] === 'true',
  ...(process.env['VITE_TENANT_HEADER']
    ? { tenantHeader: process.env['VITE_TENANT_HEADER'] }
    : {}),
  description:
    'bmkb-doc-chat: TRUE Managed Knowledge Base (type=MANAGED, Bedrock-managed vector store) + CUSTOM-connector data source via custom resource, S3, API GW, Lambdas, SQS+DLQ, DynamoDB (status + rate tokens). See README.',
});

app.synth();
