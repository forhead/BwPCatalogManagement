export const handler = async (event) => {
  console.log('BWP event received:', event);
  try {
    // TODO: Implement BWP event handling
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Event processed' })
    };
  } catch (error) {
    console.error('Error processing event:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Internal server error' })
    };
  }
};
