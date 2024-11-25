// src/lambda/auth/bwp/auth.mjs
import { DynamoDB } from '@aws-sdk/client-dynamodb';

const dynamodb = new DynamoDB();

export const handler = async (event) => {
  try {
    const queryParams = event.queryStringParameters || {};
    const { shop } = queryParams;

    if (!shop) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing shop parameter' }),
      };
    }

    // 生成BWP授权URL
    const authUrl = new URL('https://api.buywithprime.amazon.com/oauth/authorize');
    authUrl.searchParams.append('client_id', process.env.BWP_CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', process.env.CALLBACK_URL);
    authUrl.searchParams.append('scope', 'products:read products:write');
    authUrl.searchParams.append('state', shop);
    authUrl.searchParams.append('response_type', 'code');

    // 记录授权状态
    await dynamodb.putItem({
      TableName: process.env.INSTALLATION_TABLE,
      Item: {
        id: { S: shop },
        platform: { S: 'bwp' },
        status: { S: 'pending' },
        createdAt: { N: Date.now().toString() },
      },
    });

    return {
      statusCode: 302,
      headers: {
        Location: authUrl.toString(),
      },
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};