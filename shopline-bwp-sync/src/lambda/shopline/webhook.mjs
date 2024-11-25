export const handler = async (event) => {
  console.log('Shopline webhook received:', event);
  try {
    // TODO: Implement webhook handling
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Webhook processed' })
    };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Internal server error' })
    };
  }
};
