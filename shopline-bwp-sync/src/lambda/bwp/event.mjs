// event.mjs

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
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

// 获取所有安装的商店信息
async function getAllStores() {
  const scanResult = await docClient.send(new ScanCommand({
    TableName: process.env.INSTALLATION_TABLE,
    FilterExpression: "platform = :platform",
    ExpressionAttributeValues: {
      ":platform": "shopline"
    }
  }));

  return scanResult.Items;
}

// 从 Shopline 获取产品详情
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

// 从 BWP 获取产品详情
async function getBWPProducts(installationId) {
  const credentials = await getBWPCredentials(installationId);
  const response = await axios.get(`https://api.buywithprime.amazon.com/v1/products`, {
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
    console.log('Received event:', JSON.stringify(event));

    const stores = await getAllStores();

    for (const store of stores) {
      const handle = store.id;
      const bwpInstallationId = store.bwpInstallationId;

      if (!bwpInstallationId) {
        console.log(`BWP installation ID not found for store ${handle}, skipping...`);
        continue;
      }

      const shoplineProducts = await getShoplineProducts(handle);
      const bwpProducts = await getBWPProducts(bwpInstallationId);

      for (const shoplineProduct of shoplineProducts) {
        const bwpProduct = bwpProducts.find(p => p.id === shoplineProduct.id);

        if (bwpProduct && compareProducts(shoplineProduct, bwpProduct)) {
          const updatedBWPProduct = convertToBWPFormat(shoplineProduct);
          await updateBWPProduct(bwpInstallationId, shoplineProduct.id, updatedBWPProduct);
          console.log(`Updated BWP product ${shoplineProduct.id} for store ${handle}`);
        } else if (!bwpProduct) {
          const newBWPProduct = convertToBWPFormat(shoplineProduct);
          await updateBWPProduct(bwpInstallationId, shoplineProduct.id, newBWPProduct);
          console.log(`Created new BWP product ${shoplineProduct.id} for store ${handle}`);
        } else {
          console.log(`No update needed for BWP product ${shoplineProduct.id} for store ${handle}`);
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Product sync completed successfully' })
    };
  } catch (error) {
    console.error('Error processing event:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to process event' })
    };
  }
};