# BwPCatalogManagement
this is an application which can manage the catalog on Shopline and BwP

# develop code version
``` 
node -v
v22.11.0
npm -v
10.9.0
```

# code structure 
* npm run build
* cdk synth
* cdk deploy --all

# update the secretsmanager
aws secretsmanager update-secret --secret-id ShoplineCredentials --secret-string '{"appKey":"your-key","appSecret":"your-secret"}'
aws secretsmanager update-secret --secret-id BwpCredentials --secret-string '{"clientId":"your-id","clientSecret":"your-secret"}'

# 安装 SAM CLI
pip install aws-sam-cli

# 使用CDK生成SAM模板
cdk synth --no-staging > template.yaml

# 本地调用Lambda函数
sam local invoke ShoplineWebhookHandler --event events/webhook-event.json

# 本地启动API Gateway
sam local start-api