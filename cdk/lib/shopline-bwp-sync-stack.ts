// lib/shopline-bwp-sync-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration } from 'aws-cdk-lib';

export class ShoplineBwpSyncStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Tables
    const installationTable = new dynamodb.Table(this, 'InstallationTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'platform', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    const bwpTokenStoreTable = new dynamodb.Table(this, 'BwpTokenStore', {
      partitionKey: { name: 'installation_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // Secrets
    const shoplineCredentials = new secretsmanager.Secret(this, 'ShoplineCredentials', {
      description: 'Shopline API credentials',
    });

    const bwpCredentials = new secretsmanager.Secret(this, 'BwpCredentials', {
      description: 'BWP API credentials',
    });

    // Lambda Functions
    const lambdaEnvironment = {
      INSTALLATION_TABLE: installationTable.tableName,
      BWP_TOKEN_STORE_TABLE: bwpTokenStoreTable.tableName,
      SHOPLINE_CREDENTIALS_ARN: shoplineCredentials.secretArn,
      BWP_CREDENTIALS_ARN: bwpCredentials.secretArn,
    };

    // Common Lambda role
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // Add permissions to Lambda role
    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );
    
    installationTable.grantReadWriteData(lambdaRole);
    bwpTokenStoreTable.grantReadWriteData(lambdaRole);
    shoplineCredentials.grantRead(lambdaRole);
    bwpCredentials.grantRead(lambdaRole);

    // Shopline Webhook Handler
    const shoplineWebhookHandler = new lambda.Function(this, 'ShoplineWebhookHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset('../shopline-bwp-sync/src/lambda'),
      handler: 'webhook.handler',
      environment: lambdaEnvironment,
      timeout: Duration.seconds(30),
      memorySize: 256,
      role: lambdaRole,
    });

    // Event Handler (for EventBridge)
    const eventHandler = new lambda.Function(this, 'EventHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset('../shopline-bwp-sync/src/lambda'),
      handler: 'event.handler',
      environment: lambdaEnvironment,
      timeout: Duration.seconds(300),
      memorySize: 512,
      role: lambdaRole,
    });

    // Product CRUD Handler
    const productCrudHandler = new lambda.Function(this, 'ProductCrudHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset('../shopline-bwp-sync/src/lambda'),
      handler: 'product/crud.handler',
      environment: lambdaEnvironment,
      timeout: Duration.seconds(30),
      memorySize: 256,
      role: lambdaRole,
    });

    // API Gateway Logging Role
    const apiGatewayLoggingRole = new iam.Role(this, 'ApiGatewayLoggingRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')
      ],
    });

    // API Gateway Account
    new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGatewayLoggingRole.roleArn
    });

    // API Gateway
    const api = new apigateway.RestApi(this, 'ShoplineBwpApi', {
      restApiName: 'Shopline BWP Sync API',
      description: 'API for Shopline BWP product sync',
      deployOptions: {
        stageName: 'prod',
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
    });

    // API Resources and Methods
    const webhooks = api.root.addResource('webhooks');
    const shoplineWebhook = webhooks.addResource('shopline');
    shoplineWebhook.addMethod('POST', new apigateway.LambdaIntegration(shoplineWebhookHandler));

    const products = api.root.addResource('products');
    products.addMethod('GET', new apigateway.LambdaIntegration(productCrudHandler), {
      requestParameters: {
        'method.request.querystring.handle': true,
      },
    });
    
    const product = products.addResource('{id}');
    product.addMethod('PUT', new apigateway.LambdaIntegration(productCrudHandler), {
      requestParameters: {
        'method.request.querystring.handle': true,
      },
    });

    // EventBridge Rule for periodic sync
    const syncRule = new events.Rule(this, 'SyncRule', {
      schedule: events.Schedule.rate(Duration.hours(1)),
    });

    syncRule.addTarget(new targets.LambdaFunction(eventHandler));

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });
  }
}