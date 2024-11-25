import crypto from 'crypto';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import axios from 'axios';
import jwt from 'jsonwebtoken';

const secretsManager = new SecretsManager();
const dynamodb = new DynamoDB();
const docClient = DynamoDBDocumentClient.from(dynamodb);

const BWP_PUBLIC_KEY = 
`-----BEGIN PUBLIC KEY----- 
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9NrnQefbdiD4Tk65eY2r/fXtf4VV
PIBdR7qP73NhRBdNhUNfERayW67OP+ufvhpgdWUcbxXQkos8KkwL8yRMzQ==
-----END PUBLIC KEY-----`;

const BWP_AUTHORIZE_URL = "https://console.buywithprime.amazon.com/marketplace/authorize";
const BWP_TOKEN_URL = "https://api.ais.prod.vinewood.dubai.aws.dev/token";

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

// 获取BWP凭证
async function getBWPCredentials() {
  try {
    const secretValue = await secretsManager.getSecretValue({
      SecretId: process.env.BWP_CREDENTIALS_ARN,
    });
    return JSON.parse(secretValue.SecretString);
  } catch (error) {
    console.error('Error fetching BWP credentials:', error);
    throw new Error('Failed to get BWP credentials');
  }
}

// Shopline 相关函数
async function generateSign(params, secret) {
  // ... (保持不变)
}

async function verifySign(params, secret) {
  // ... (保持不变)
}

// BWP 相关函数
function validateVerificationToken(event) {
  let token = event.queryStringParameters?.["verification-token"] || event.headers?.["verification-token"];

  if(!token) {
    throw new Error("Missing Verification Token");
  }

  let payload = jwt.verify(token, BWP_PUBLIC_KEY);

  let expectedHash = payload.requestHash;
  let actualHash = calculateRequestHash(event);

  if(expectedHash !== actualHash) {
    throw new Error("Actual request hash does not match the expected hash");
  }    

  return payload;
}

function calculateRequestHash(event) {
  let url = `https://${event.headers.Host}${event.rawPath}`;

  if(url.includes("verification-token")) {
    url = url.substring(0, url.indexOf("verification-token=") - 1);
  }

  let bodyHash = event.body ? crypto.createHash('sha256').update(event.body, "utf8").digest('hex') : "";
  return crypto.createHash('sha256').update(url + bodyHash, "utf8").digest('hex');
}

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('hex');
}

function generateCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return hash.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export const handler = async (event) => {
  console.log('Event received:', event);
  try {
    const path = event.rawPath;
    const httpMethod = event.requestContext.http.method;

    if (path.startsWith('/shopline')) {
      return handleShopline(event);
    } else if (path.startsWith('/bwp')) {
      return handleBWP(event);
    } else {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Not Found' })
      };
    }
  } catch (error) {
    console.error('Error processing event:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Internal server error' })
    };
  }
};

async function handleShopline(event) {
  // 原有的 Shopline 处理逻辑
  // ... (保持不变)
}

async function handleBWP(event) {
  const path = event.rawPath;
  const httpMethod = event.requestContext.http.method;

  if (path === "/bwp/launch" && httpMethod === "GET") {
    return handleBWPLaunch(event);
  } else if (path === "/bwp/install" && httpMethod === "GET") {
    return handleBWPInstall(event);
  } else if (path === "/bwp/settings" && httpMethod === "GET") {
    return handleBWPSettings(event);
  } else if (path === "/bwp/uninstall" && httpMethod === "POST") {
    return handleBWPUninstall(event);
  } else {
    return {
      statusCode: 404,
      body: JSON.stringify({ message: 'Not Found' })
    };
  }
}

async function handleBWPLaunch(event) {
  const credentials = await getBWPCredentials();
  let state = Math.random().toString();
  let codeVerifier = generateCodeVerifier();
  let codeChallenge = generateCodeChallenge(codeVerifier);
  
  // 存储 state 和 codeVerifier，这里使用 DynamoDB 作为示例
  await docClient.send(new PutCommand({
    TableName: process.env.BWP_STATE_TABLE,
    Item: {
      state: state,
      codeVerifier: codeVerifier,
      createdAt: Date.now()
    }
  }));

  let redirect_url = `${BWP_AUTHORIZE_URL}?response_type=code&client_id=${credentials.clientId}&state=${state}&redirect_uri=${encodeURIComponent(process.env.BWP_INSTALL_URL)}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
  
  console.log("BWP Launch request initiated");
  console.log(redirect_url);
  
  return {
    statusCode: 302,
    headers: {
      Location: redirect_url
    },
    body: JSON.stringify({ message: 'Redirecting to BWP authorization URL' })
  };
}

async function handleBWPInstall(event) {
  try {
    let tokenPayload = validateVerificationToken(event);
    var installationId = tokenPayload.installationId;
    console.log("BWP installation ID is ", installationId);

    let authCode = event.queryStringParameters.code;
    let state = event.queryStringParameters.state;

    // 从 DynamoDB 获取 codeVerifier
    const stateData = await docClient.send(new GetCommand({
      TableName: process.env.BWP_STATE_TABLE,
      Key: { state: state }
    }));

    if (!stateData.Item) {
      throw new Error("Invalid state");
    }

    let codeVerifier = stateData.Item.codeVerifier;

    const credentials = await getBWPCredentials();
    const response = await axios.post(
      BWP_TOKEN_URL,
      `grant_type=authorization_code&client_id=${credentials.clientId}&client_secret=${credentials.clientSecret}&redirect_uri=${encodeURIComponent(process.env.BWP_INSTALL_URL)}&code=${authCode}&code_verifier=${codeVerifier}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    console.log(`BWP Auth Token: ${JSON.stringify(response.data)}`);
    
    await docClient.send(new PutCommand({
      TableName: process.env.BWP_TOKEN_STORE_TABLE,
      Item: {
        installation_id: installationId,
        updated_at: Date.now() / 1000,
        token: response.data.access_token,
        refresh_token: response.data.refresh_token
      }
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'BWP installation successful' })
    };
  } catch (error) {
    console.error('Error in BWP install:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'BWP installation failed' })
    };
  }
}

async function handleBWPSettings(event) {
  try {
    let payload = validateVerificationToken(event);
    console.log("BWP settings for installation ID: ", payload.installationId);
    return {
      statusCode: 200,
      body: JSON.stringify({ installationId: payload.installationId })
    };
  } catch (error) {
    console.error('Error in BWP settings:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Failed to retrieve BWP settings' })
    };
  }
}

async function handleBWPUninstall(event) {
  try {
    let payload = validateVerificationToken(event);
    console.log("BWP uninstall requested for installation ID: ", payload.installationId);
    
    // 这里可以添加卸载逻辑，比如从数据库中删除相关记录

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'BWP uninstallation successful' })
    };
  } catch (error) {
    console.error('Error in BWP uninstall:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'BWP uninstallation failed' })
    };
  }
}