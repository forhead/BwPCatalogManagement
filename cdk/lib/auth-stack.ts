import * as path from 'path';
import * as fs from 'fs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Duration, SecretValue } from 'aws-cdk-lib';

export class AuthStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 验证和解析Lambda代码路径
    const lambdaPath = path.resolve(__dirname, '../../shopline-bwp-sync/src/lambda/auth');
    if (!fs.existsSync(lambdaPath)) {
      throw new Error(`Lambda path does not exist: ${lambdaPath}`);
    }

    // DynamoDB Tables
    const installationTable = new dynamodb.Table(this, 'InstallationTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'platform', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // Secrets
    const shoplineCredentials = new secretsmanager.Secret(this, 'ShoplineCredentials', {
      description: 'Shopline API credentials',
      secretObjectValue: {
        appKey: SecretValue.unsafePlainText(process.env.SHOPLINE_APP_KEY || 'dummy-key'),
        appSecret: SecretValue.unsafePlainText(process.env.SHOPLINE_APP_SECRET || 'dummy-secret'),
      },
    });

    const bwpCredentials = new secretsmanager.Secret(this, 'BwpCredentials', {
      description: 'BWP API credentials',
      secretObjectValue: {
        clientId: SecretValue.unsafePlainText(process.env.BWP_CLIENT_ID || 'dummy-id'),
        clientSecret: SecretValue.unsafePlainText(process.env.BWP_CLIENT_SECRET || 'dummy-secret'),
      },
    });

    // 创建Lambda角色
    const lambdaRole = new iam.Role(this, 'AuthLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Auth Lambda functions',
    });

    // 添加基本Lambda权限
    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // API Gateway
    const api = new apigateway.RestApi(this, 'AuthApi', {
      restApiName: 'Auth API',
      description: 'API for Shopline and BWP authentication',
      deployOptions: {
        stageName: 'prod',
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        tracingEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // 共享环境变量
    const commonEnvVars = {
      INSTALLATION_TABLE: installationTable.tableName,
      SHOPLINE_CREDENTIALS_ARN: shoplineCredentials.secretArn,
      BWP_CREDENTIALS_ARN: bwpCredentials.secretArn,
      APP_URL: process.env.APP_URL || '',
      NODE_OPTIONS: '--enable-source-maps',
      API_GATEWAY_ID: api.restApiId,
      API_GATEWAY_STAGE: 'prod',
    };

    // 创建Lambda函数
    const createLambda = (name: string, handler: string, codePath: string) => {
      return new lambda.Function(this, name, {
        runtime: lambda.Runtime.NODEJS_18_X,
        code: lambda.Code.fromAsset(codePath),
        handler,
        environment: commonEnvVars,
        timeout: Duration.seconds(30),
        memorySize: 256,
        role: lambdaRole,
        logRetention: logs.RetentionDays.ONE_WEEK,
        tracing: lambda.Tracing.ACTIVE,
      });
    };

    // API Gateway Account Role for CloudWatch Logs
    const apiGatewayLoggingRole = new iam.Role(this, 'ApiGatewayLoggingRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonAPIGatewayPushToCloudWatchLogs'
        ),
      ],
    });

    // Set up API Gateway Account
    new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGatewayLoggingRole.roleArn,
    });

    // API Routes
    const auth = api.root.addResource('auth');
    const shopline = auth.addResource('shopline');
    const bwp = auth.addResource('bwp');

    // Shopline Lambda Functions
    const shoplineInstallHandler = createLambda(
      'ShoplineInstallHandler',
      'install.handler',
      path.join(lambdaPath, 'shopline')
    );

    const shoplineCallbackHandler = createLambda(
      'ShoplineCallbackHandler',
      'callback.handler',
      path.join(lambdaPath, 'shopline')
    );

    const shoplineTokenRefreshHandler = createLambda(
      'ShoplineTokenRefreshHandler',
      'refresh.handler',
      path.join(lambdaPath, 'shopline')
    );

    // BWP Lambda Functions
    const bwpAuthHandler = createLambda(
      'BwpAuthHandler',
      'auth.handler',
      path.join(lambdaPath, 'bwp')
    );

    const bwpCallbackHandler = createLambda(
      'BwpCallbackHandler',
      'callback.handler',
      path.join(lambdaPath, 'bwp')
    );

    const bwpTokenRefreshHandler = createLambda(
      'BwpTokenRefreshHandler',
      'refresh.handler',
      path.join(lambdaPath, 'bwp')
    );

    // Grant permissions
    installationTable.grantReadWriteData(lambdaRole);
    shoplineCredentials.grantRead(lambdaRole);
    bwpCredentials.grantRead(lambdaRole);

    // Shopline routes
    const shoplineInstall = shopline.addResource('install');
    shoplineInstall.addMethod('GET', new apigateway.LambdaIntegration(shoplineInstallHandler), {
      requestParameters: {
        'method.request.querystring.handle': true,
      },
    });

    const shoplineCallback = shopline.addResource('callback');
    shoplineCallback.addMethod('GET', new apigateway.LambdaIntegration(shoplineCallbackHandler), {
      requestParameters: {
        'method.request.querystring.code': true,
        'method.request.querystring.handle': true,
      },
    });

    // BWP routes
    const bwpAuth = bwp.addResource('auth');
    bwpAuth.addMethod('GET', new apigateway.LambdaIntegration(bwpAuthHandler), {
      requestParameters: {
        'method.request.querystring.handle': true,
      },
    });

    const bwpCallback = bwp.addResource('callback');
    bwpCallback.addMethod('GET', new apigateway.LambdaIntegration(bwpCallbackHandler), {
      requestParameters: {
        'method.request.querystring.code': true,
        'method.request.querystring.handle': true,
      },
    });

    // EventBridge Rules
    new events.Rule(this, 'ShoplineTokenRefreshRule', {
      schedule: events.Schedule.rate(Duration.days(7)),
      targets: [new targets.LambdaFunction(shoplineTokenRefreshHandler)],
      description: 'Refresh Shopline access tokens periodically',
    });

    new events.Rule(this, 'BwpTokenRefreshRule', {
      schedule: events.Schedule.rate(Duration.days(7)),
      targets: [new targets.LambdaFunction(bwpTokenRefreshHandler)],
      description: 'Refresh BWP access tokens periodically',
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
      exportName: 'AuthApiUrl',
    });

    new cdk.CfnOutput(this, 'InstallationTableName', {
      value: installationTable.tableName,
      description: 'DynamoDB Installation Table Name',
      exportName: 'InstallationTableName',
    });
  }
}