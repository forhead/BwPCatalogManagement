// src/lambda/auth/shopline/refresh.mjs
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

export const handler = async (event) => {
  try {
    console.log('Token refresh started');
    const credentials = await getShoplineCredentials();
    const { tokens } = credentials;

    if (!tokens) {
      console.log('No tokens found to refresh');
      return { 
        statusCode: 200, 
        body: JSON.stringify({ message: 'No tokens to refresh' }) 
      };
    }

    for (const [handle, tokenData] of Object.entries(tokens)) {
      try {
        // 检查是否需要刷新
        if (tokenData.expiresAt > Date.now() + (24 * 60 * 60 * 1000)) {
          console.log(`Token for ${handle} does not need refresh yet`);
          continue;
        }

        // 准备刷新token的请求
        const refreshParams = {
          appkey: credentials.appKey,
          timestamp: Math.floor(Date.now() / 1000).toString(),
        };

        const refreshSign = await generateSign(refreshParams, credentials.appSecret);

        // 请求刷新token
        const response = await fetch(
          `https://${handle}.myshopline.com/admin/oauth/token/refresh`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'appkey': credentials.appKey,
              'timestamp': refreshParams.timestamp,
              'sign': refreshSign,
            },
            body: JSON.stringify({
              refresh_token: tokenData.refreshToken,
            }),
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to refresh token: ${await response.text()}`);
        }

        const newTokenData = await response.json();

        // 更新token
        tokens[handle] = {
          accessToken: newTokenData.access_token,
          refreshToken: newTokenData.refresh_token,
          expiresAt: Date.now() + (newTokenData.expires_in * 1000),
        };

        // 更新数据库状态
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
            ':status': { S: 'token_refreshed' },
            ':updatedAt': { N: Date.now().toString() },
            ':tokenExpiry': { S: new Date(tokens[handle].expiresAt).toISOString() },
          },
        });

        console.log(`Successfully refreshed token for ${handle}`);
      } catch (error) {
        console.error(`Error refreshing token for ${handle}:`, error);
      }
    }

    // 保存更新后的tokens
    await secretsManager.putSecretValue({
      SecretId: process.env.SHOPLINE_CREDENTIALS_ARN,
      SecretString: JSON.stringify({
        ...credentials,
        tokens,
      }),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Token refresh completed' }),
    };
  } catch (error) {
    console.error('Error in token refresh:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Token refresh failed' }),
    };
  }
};