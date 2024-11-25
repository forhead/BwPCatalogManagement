#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ShoplineBwpSyncStack } from '../lib/shopline-bwp-sync-stack';
import { AuthStack } from '../lib/auth-stack';


const app = new cdk.App();
new ShoplineBwpSyncStack(app, 'ShoplineBwpSyncStack', {
  description: 'Shopline and BWP managerment infrastructure',
});

new AuthStack(app, 'ShoplineBwpAuthStack', {
  // 使用当前CLI配置的账号和区域
  description: 'Shopline and BWP authentication infrastructure',
});