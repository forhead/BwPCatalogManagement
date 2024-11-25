import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManager } from "@aws-sdk/client-secrets-manager";
import axios from 'axios';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsManager = new SecretsManager();

// 获取 Shopline 凭证
async function getShoplineCredentials() {
  const secretValue = await secretsManager.getSecretValue({
    SecretId: process.env.SHOPLINE_CREDENTIALS_ARN,
  });
  return JSON.parse(secretValue.SecretString);
}

// 获取 BWP 凭证和 token
async function getBWPCredentials(installationId) {
  const tokenData = await docClient.send(new GetCommand({
    TableName: process.env.BWP_TOKEN_STORE_TABLE,
    Key: { installation_id: installationId }
  }));

  if (!tokenData.Item) {
    throw new Error("BWP token not found");
  }

  const secretValue = await secretsManager.getSecretValue({
    SecretId: process.env.BWP_CREDENTIALS_ARN,
  });
  const credentials = JSON.parse(secretValue.SecretString);

  return {
    ...credentials,
    accessToken: tokenData.Item.token,
    refreshToken: tokenData.Item.refresh_token
  };
}

// 获取商店信息
async function getStoreInfo(handle) {
  const storeData = await docClient.send(new GetCommand({
    TableName: process.env.INSTALLATION_TABLE,
    Key: { id: handle, platform: 'shopline' }
  }));

  if (!storeData.Item) {
    throw new Error("Store information not found");
  }

  return storeData.Item;
}

// 从 Shopline 获取所有产品
async function getShoplineProducts(handle) {
  const credentials = await getShoplineCredentials();
  const response = await axios.get(`https://${handle}.myshopline.com/admin/openapi/v20230901/products`, {
    headers: {
      'Authorization': `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  return response.data.data;
}

// 更新 Shopline 产品
async function updateShoplineProduct(handle, productId, productData) {
  const credentials = await getShoplineCredentials();
  await axios.put(`https://${handle}.myshopline.com/admin/openapi/v20230901/products/${productId}`, productData, {
    headers: {
      'Authorization': `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json'
    }
  });
}

// 更新 BWP 产品
async function updateBWPProduct(installationId, productId, productData) {
  const credentials = await getBWPCredentials(installationId);
  await axios.put(`https://api.buywithprime.amazon.com/v1/products/${productId}`, productData, {
    headers: {
      'Authorization': `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json'
    }
  });
}

export const handler = async (event) => {
  const { httpMethod, path, body, queryStringParameters } = event;
  const handle = queryStringParameters?.handle;

  if (!handle) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Missing handle' })
    };
  }

  try {
    const storeInfo = await getStoreInfo(handle);

    switch (httpMethod) {
      case 'GET':
        if (path === '/products') {
          const products = await getShoplineProducts(handle);
          return {
            statusCode: 200,
            body: JSON.stringify(products)
          };
        }
        break;

      case 'PUT':
        if (path.startsWith('/products/')) {
          const productId = path.split('/')[2];
          const productData = JSON.parse(body);
          
          // 更新 Shopline
          await updateShoplineProduct(handle, productId, productData);
          
          // 更新 BWP
          const bwpInstallationId = storeInfo.bwpInstallationId;
          if (!bwpInstallationId) {
            throw new Error("BWP installation ID not found for this store");
          }
          await updateBWPProduct(bwpInstallationId, productId, productData);
          
          return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Product updated successfully' })
          };
        }
        break;

      // 可以根据需要添加其他 CRUD 操作

      default:
        return {
          statusCode: 404,
          body: JSON.stringify({ message: 'Not Found' })
        };
    }
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Internal Server Error', error: error.message })
    };
  }
};

// BWP 安装时更新商店信息的辅助函数
export async function updateStoreBWPInfo(shoplineHandle, bwpInstallationId) {
  await docClient.send(new UpdateCommand({
    TableName: process.env.INSTALLATION_TABLE,
    Key: { id: shoplineHandle, platform: 'shopline' },
    UpdateExpression: "set bwpInstallationId = :bwpId",
    ExpressionAttributeValues: {
      ":bwpId": bwpInstallationId
    }
  }));
}