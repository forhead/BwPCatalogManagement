import crypto from 'crypto';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { DynamoDB } from '@aws-sdk/client-dynamodb';

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
  // 按字母顺序排序参数
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      acc[key] = params[key];
      return acc;
    }, {});

  // 构造签名字符串
  const signString = Object.entries(sortedParams)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  // 使用HMAC-SHA256生成签名
  return crypto
    .createHmac('sha256', secret)
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
    console.log('Installation request received:', event);
    const params = event.queryStringParameters || {};
    const { appkey, handle, timestamp, sign } = params;

    // 验证必要参数
    if (!appkey || !handle || !timestamp || !sign) {
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

    // 记录安装状态
    await dynamodb.putItem({
      TableName: process.env.INSTALLATION_TABLE,
      Item: {
        id: { S: handle },
        platform: { S: 'shopline' },
        status: { S: 'installing' },
        appkey: { S: appkey },
        timestamp: { N: timestamp },
        createdAt: { N: Date.now().toString() },
      },
    });

    // 构建callback URL
    const callbackUrl = `https://${process.env.API_GATEWAY_ID}.execute-api.us-east-1.amazonaws.com/${process.env.API_GATEWAY_STAGE}/auth/shopline/callback`;
    
    const encodedCallbackUrl = encodeURIComponent(callbackUrl);

    // 构建授权URL
    const authParams = new URLSearchParams({
      appKey: credentials.appKey,
      responseType: 'code',
      scope: 'read_products,write_products',
      redirectUri: encodedCallbackUrl, // 使用已编码的URL
    });

    const authUrl = `https://${handle}.myshopline.com/admin/oauth-web/#/oauth/authorize?${authParams.toString()}`;

    console.log('Redirecting to:', authUrl); // 添加日志便于调试

    return {
      statusCode: 302,
      headers: {
        Location: authUrl,
      },
    };
  } catch (error) {
    console.error('Error handling installation:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Installation failed' }),
    };
  }
};