// webhook.mjs

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
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

// 从 Shopline 获取产品详情
async function getShoplineProduct(handle, productId) {
  const credentials = await getShoplineCredentials();
  const response = await axios.get(`https://${handle}.myshopline.com/admin/openapi/v20230901/products/${productId}`, {
    headers: {
      'Authorization': `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  return response.data.data;
}

// 从 BWP 获取产品详情
async function getBWPProduct(installationId, productId) {
  const credentials = await getBWPCredentials(installationId);
  const response = await axios.get(`https://api.buywithprime.amazon.com/v1/products/${productId}`, {
    headers: {
      'Authorization': `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  return response.data;
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

// 比较 Shopline 和 BWP 产品数据
function compareProducts(shoplineProduct, bwpProduct) {
  // 这里需要根据具体的数据结构来实现比较逻辑
  // 以下只是一个简单的示例
  return (
    shoplineProduct.title !== bwpProduct.title ||
    shoplineProduct.description !== bwpProduct.description ||
    shoplineProduct.price !== bwpProduct.price
  );
}

// 将 Shopline 产品数据转换为 BWP 格式
function convertToBWPFormat(shoplineProduct) {
  // 这里需要根据 BWP 的 API 要求来转换数据
  // 以下只是一个简单的示例
  return {
    title: shoplineProduct.title,
    description: shoplineProduct.description,
    price: shoplineProduct.price,
    // 添加其他必要的字段...
  };
}

export const handler = async (event) => {
  try {
    const webhookData = JSON.parse(event.body);
    const { handle, productId } = webhookData;

    if (!handle || !productId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameters' })
      };
    }

    const storeInfo = await getStoreInfo(handle);
    const bwpInstallationId = storeInfo.bwpInstallationId;

    if (!bwpInstallationId) {
      throw new Error("BWP installation ID not found for this store");
    }

    const shoplineProduct = await getShoplineProduct(handle, productId);
    const bwpProduct = await getBWPProduct(bwpInstallationId, productId);

    if (compareProducts(shoplineProduct, bwpProduct)) {
      const updatedBWPProduct = convertToBWPFormat(shoplineProduct);
      await updateBWPProduct(bwpInstallationId, productId, updatedBWPProduct);
      console.log(`Updated BWP product ${productId} for store ${handle}`);
    } else {
      console.log(`No update needed for BWP product ${productId} for store ${handle}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Webhook processed successfully' })
    };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to process webhook' })
    };
  }
};