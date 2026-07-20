import { defineBackend } from '@aws-amplify/backend';
import { HttpApi, CorsHttpMethod, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { kenterApi } from './functions/kenter-api/resource';

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  auth,
  data,
  kenterApi,
});

const apiStack = backend.createStack('kenter-api-stack');
const kenterHttpApi = new HttpApi(apiStack, 'KenterHttpApi', {
  corsPreflight: {
    allowHeaders: ['content-type', 'authorization'],
    allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
    allowOrigins: ['*'],
  },
});

const kenterIntegration = new HttpLambdaIntegration(
  'KenterLambdaIntegration',
  backend.kenterApi.resources.lambda,
);

kenterHttpApi.addRoutes({
  path: '/{proxy+}',
  methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.OPTIONS],
  integration: kenterIntegration,
});

backend.addOutput({
  custom: {
    kenter_api_url: kenterHttpApi.url,
  },
});
