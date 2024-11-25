// src/handlers/auth/shopline-install.mjs
import { DynamoDB, SecretsManager } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes } from 'crypto';
import axios from 'axios';

// AWS服务初始化
const dynamodb = DynamoDBDocument.from(new DynamoDB({}));
const secretsManager = new SecretsManager({});

// 常量定义
const SHOPLINE_AUTH_URL = 'https://accounts.shopline.com/oauth/authorize';
const SHOPLINE_TOKEN_URL = 'https://accounts.shopline.com/oauth/token';

// 获取secrets
async function getSecrets() {
    const secretResponse = await secretsManager.getSecretValue({
        SecretId: process.env.SHOPLINE_SECRETS_ARN
    });
    
    return JSON.parse(secretResponse.SecretString);
}

// 生成随机状态
function generateState() {
    return randomBytes(32).toString('hex');
}

// 验证请求来源
function validateRequest(event) {
    const shop = event.queryStringParameters?.shop;
    if (!shop) {
        throw new Error('Missing shop parameter');
    }
    
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopline\.com$/.test(shop)) {
        throw new Error('Invalid shop domain');
    }
    
    return shop;
}

// 主处理函数
export const handler = async (event, context) => {
    console.log('Shopline installation started', { event });

    try {
        // 验证请求
        const shop = validateRequest(event);
        
        // 获取secrets
        const secrets = await getSecrets();
        const { clientId, clientSecret } = secrets;
        
        // 生成状态值
        const state = generateState();
        
        // 存储状态和shop信息
        await dynamodb.put({
            TableName: process.env.INSTALL_STATE_TABLE,
            Item: {
                state,
                shop,
                timestamp: Date.now(),
                type: 'shopline_install',
                expiry: Math.floor(Date.now() / 1000) + 3600
            }
        });
        
        // 构建授权URL
        const authUrl = new URL(SHOPLINE_AUTH_URL);
        authUrl.searchParams.append('client_id', clientId);
        authUrl.searchParams.append('scope', 'read_products write_products read_orders');
        authUrl.searchParams.append('redirect_uri', process.env.SHOPLINE_REDIRECT_URI);
        authUrl.searchParams.append('state', state);
        authUrl.searchParams.append('response_type', 'code');
        
        return {
            statusCode: 302,
            headers: {
                'Location': authUrl.toString(),
                'Cache-Control': 'no-store'
            }
        };

    } catch (error) {
        console.error('Installation initialization failed', { error });
        
        return {
            statusCode: error.statusCode || 500,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                error: error.message || 'Internal server error',
                requestId: event.requestContext?.requestId
            })
        };
    }
};

// Callback处理函数
export const handleCallback = async (event, context) => {
    console.log('Shopline callback received', { event });

    try {
        const { code, state } = event.queryStringParameters;

        if (!code || !state) {
            throw new Error('Missing required parameters');
        }

        // 验证状态
        const stateRecord = await dynamodb.get({
            TableName: process.env.INSTALL_STATE_TABLE,
            Key: { state }
        });

        if (!stateRecord.Item || stateRecord.Item.type !== 'shopline_install') {
            throw new Error('Invalid state');
        }

        const shop = stateRecord.Item.shop;

        // 获取secrets
        const secrets = await getSecrets();
        const { clientId, clientSecret } = secrets;

        // 获取访问令牌
        const tokenResponse = await axios.post(SHOPLINE_TOKEN_URL, {
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: process.env.SHOPLINE_REDIRECT_URI
        });

        // 存储访问令牌
        await dynamodb.put({
            TableName: process.env.STORES_TABLE,
            Item: {
                shop,
                accessToken: tokenResponse.data.access_token,
                refreshToken: tokenResponse.data.refresh_token,
                scope: tokenResponse.data.scope,
                installedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        });

        // 删除状态记录
        await dynamodb.delete({
            TableName: process.env.INSTALL_STATE_TABLE,
            Key: { state }
        });

        // 重定向到应用页面
        return {
            statusCode: 302,
            headers: {
                'Location': `${process.env.APP_URL}?shop=${shop}`,
                'Cache-Control': 'no-store'
            }
        };

    } catch (error) {
        console.error('Installation callback failed', { error });
        
        return {
            statusCode: error.statusCode || 500,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                error: error.message || 'Installation failed',
                requestId: event.requestContext?.requestId
            })
        };
    }
};