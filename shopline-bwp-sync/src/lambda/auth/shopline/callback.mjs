// src/lambda/auth/shopline/callback.mjs
import crypto from 'crypto';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import fetch from 'node-fetch';

const secretsManager = new SecretsManager();
const dynamodb = new DynamoDB();

// 获取Shopline凭证
async function getShoplineCredentials() {
  try {
    const secretValue = await secretsManager.getSecretValue({
      SecretId: process.env.SHOPLINE_CREDENTIALS_ARN,
    });
    return JSON.parse(secretValue.SecretString);
  } catch (error) {
    console.error('Error fetching Shopline credentials:', error);
    throw new Error('Failed to get Shopline credentials');
  }
}

// 生成签名
async function generateSign(params, secret) {
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      acc[key] = params[key];
      return acc;
    }, {});

  const signString = Object.entries(sortedParams)
    .map(([key, value]) => `${key}=${value}`)
    .join('&') + secret;

  return crypto
    .createHash('md5')
    .update(signString)
    .digest('hex');
}

// 验证签名
async function verifySign(params, secret) {
  const { sign, ...rest } = params;
  const calculatedSign = await generateSign(rest, secret);
  return sign === calculatedSign;
}

export const handler = async (event) => {
  try {
    console.log('Callback request received:', event);
    const params = event.queryStringParameters || {};
    const { appkey, code, handle, timestamp, sign } = params;

    // 验证必要参数
    if (!appkey || !code || !handle || !timestamp || !sign) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameters' }),
      };
    }

    // 获取凭证
    const credentials = await getShoplineCredentials();

    // 验证签名
    if (!await verifySign(params, credentials.appSecret)) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid signature' }),
      };
    }

    // 准备获取access token的请求
    const tokenParams = {
      appkey: credentials.appKey,
      timestamp: Math.floor(Date.now() / 1000).toString(),
    };

    const tokenSign = await generateSign(tokenParams, credentials.appSecret);

    // 请求access token
    const tokenResponse = await fetch(
      `https://${handle}.myshopline.com/admin/oauth/token/create`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'appkey': credentials.appKey,
          'timestamp': tokenParams.timestamp,
          'sign': tokenSign,
        },
        body: JSON.stringify({ code }),
      }
    );

    if (!tokenResponse.ok) {
      console.error('Token request failed:', await tokenResponse.text());
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to get access token' }),
      };
    }

    const tokenData = await tokenResponse.json();

    // 更新存储的凭证
    await secretsManager.putSecretValue({
      SecretId: process.env.SHOPLINE_CREDENTIALS_ARN,
      SecretString: JSON.stringify({
        ...credentials,
        tokens: {
          ...(credentials.tokens || {}),
          [handle]: {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + (tokenData.expires_in * 1000),
          },
        },
      }),
    });

    // 更新安装状态
    await dynamodb.updateItem({
      TableName: process.env.INSTALLATION_TABLE,
      Key: {
        id: { S: handle },
        platform: { S: 'shopline' },
      },
      UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt, #tokenExpiry = :tokenExpiry',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#updatedAt': 'updatedAt',
        '#tokenExpiry': 'tokenExpiry',
      },
      ExpressionAttributeValues: {
        ':status': { S: 'installed' },
        ':updatedAt': { N: Date.now().toString() },
        ':tokenExpiry': { S: new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString() },
      },
    });

    return {
      statusCode: 302,
      headers: {
        Location: `${process.env.APP_URL}/installation-success?handle=${handle}`,
      },
    };
  } catch (error) {
    console.error('Error handling callback:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to complete installation' }),
    };
  }
};