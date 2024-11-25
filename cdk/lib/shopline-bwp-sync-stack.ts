// lib/shopline-bwp-sync-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration } from 'aws-cdk-lib';

export class ShoplineBwpSyncStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Tables
    const productMappingTable = new dynamodb.Table(this, 'ProductMapping', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'platform', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // Add GSI for reverse lookup
    productMappingTable.addGlobalSecondaryIndex({
      indexName: 'PlatformProductIndex',
      partitionKey: { name: 'platformProductId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'platform', type: dynamodb.AttributeType.STRING },
    });

    const syncStateTable = new dynamodb.Table(this, 'SyncState', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
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

    // SQS Queues
    const deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      retentionPeriod: Duration.days(14),
    });

    const syncQueue = new sqs.Queue(this, 'SyncQueue', {
      visibilityTimeout: Duration.seconds(300),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // Lambda Functions
    const lambdaEnvironment = {
      PRODUCT_MAPPING_TABLE: productMappingTable.tableName,
      SYNC_STATE_TABLE: syncStateTable.tableName,
      SYNC_QUEUE_URL: syncQueue.queueUrl,
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
    
    productMappingTable.grantReadWriteData(lambdaRole);
    syncStateTable.grantReadWriteData(lambdaRole);
    syncQueue.grantSendMessages(lambdaRole);
    syncQueue.grantConsumeMessages(lambdaRole);
    shoplineCredentials.grantRead(lambdaRole);
    bwpCredentials.grantRead(lambdaRole);

    // Shopline Webhook Handler
    const shoplineWebhookHandler = new lambda.Function(this, 'ShoplineWebhookHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset('../shopline-bwp-sync/src/lambda/shopline'),
      handler: 'webhook.handler',
      environment: lambdaEnvironment,
      timeout: Duration.seconds(30),
      memorySize: 256,
      role: lambdaRole,
    });

    // BWP Event Handler
    const bwpEventHandler = new lambda.Function(this, 'BwpEventHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset('../shopline-bwp-sync/src/lambda/bwp'),
      handler: 'event.handler',
      environment: lambdaEnvironment,
      timeout: Duration.seconds(30),
      memorySize: 256,
      role: lambdaRole,
    });

    // Product CRUD Handler
    const productCrudHandler = new lambda.Function(this, 'ProductCrudHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset('../shopline-bwp-sync/src/lambda/product'),
      handler: 'crud.handler',
      environment: lambdaEnvironment,
      timeout: Duration.seconds(30),
      memorySize: 256,
      role: lambdaRole,
    });

    // 创建 API Gateway 的 CloudWatch 日志角色
    const apiGatewayLoggingRole = new iam.Role(this, 'ApiGatewayLoggingRole', {
        assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')
        ],
        });
    
        // 创建 API Gateway 账号设置
        const apiGatewayAccount = new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
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
    products.addMethod('GET', new apigateway.LambdaIntegration(productCrudHandler));
    products.addMethod('POST', new apigateway.LambdaIntegration(productCrudHandler));
    
    const product = products.addResource('{id}');
    product.addMethod('GET', new apigateway.LambdaIntegration(productCrudHandler));
    product.addMethod('PUT', new apigateway.LambdaIntegration(productCrudHandler));
    product.addMethod('DELETE', new apigateway.LambdaIntegration(productCrudHandler));

    // EventBridge Rule for BWP Events
    const bwpEventRule = new events.Rule(this, 'BwpEventRule', {
      eventPattern: {
        source: ['com.bwp.product'],
        detailType: ['product.updated', 'product.created', 'product.deleted'],
      },
    });

    bwpEventRule.addTarget(new targets.LambdaFunction(bwpEventHandler));

    // CloudWatch Alarms
    // TODO: Add CloudWatch alarms for monitoring

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'SyncQueueUrl', {
      value: syncQueue.queueUrl,
      description: 'Sync Queue URL',
    });
  }
}